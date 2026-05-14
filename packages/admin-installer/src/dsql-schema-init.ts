/**
 * One-shot shared-schema initializer for cloud-data-server.
 *
 * We are pre-production: there is no migration ledger and no versioning. The
 * installer simply applies the full shared-schema DDL on each run. Every
 * step is idempotent (CREATE ... IF NOT EXISTS for tables, pre-check for
 * roles), so reruns are safe.
 *
 * IMPORTANT — Aurora DSQL has a much narrower PostgreSQL surface than stock
 * Postgres. Things that WILL break here:
 *
 *   1. Multiple DDL statements in one transaction → SQLSTATE 0A000
 *      "multiple ddl statements not supported in a transaction". The pg driver
 *      runs a multi-statement string as a single simple-query, which is
 *      implicitly one transaction — so we CANNOT batch DDL by sending one big
 *      SQL blob. Every DDL statement here is executed individually so each
 *      runs in its own implicit transaction.
 *
 *   2. DO $$ ... $$ blocks (PL/pgSQL anonymous code blocks) → SQLSTATE 0A000
 *      "unsupported statement: Do". DSQL does not support PL/pgSQL. To make
 *      `CREATE ROLE` idempotent we do an explicit `SELECT FROM pg_roles`
 *      pre-check and conditionally issue the CREATE — see `ensureRole` below.
 *
 *   3. FOREIGN KEY constraints (including `REFERENCES ... ON DELETE ...`)
 *      → SQLSTATE 0A000 "FOREIGN KEY constraint not supported". DSQL has no
 *      cross-row referential integrity. Cascade/SET NULL semantics that we
 *      relied on FK declarations for must be enforced in application code
 *      (cloud-data-server's delete paths, the reclassification flow, etc.).
 *
 * If you add to this file, keep every entry to a single non-PL/pgSQL
 * statement with no FK constraints, and use the role-step pattern (or a
 * similar pre-check) for anything Postgres would normally express as
 * `IF NOT EXISTS ... DO`.
 */

import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { CORE_TYPES, pgMetadataDdl } from "@starkeep/core";

export interface SchemaInitOptions {
  hostname: string;
  region: string;
  stackPrefix: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/**
 * PG identifier for the privileged installer user. Matches the convention
 * used elsewhere in dsql-ddl.ts (lowercase, hyphens → underscores).
 */
export function installerPgUser(stackPrefix: string): string {
  return `${stackPrefix}_installer`.toLowerCase().replace(/-/g, "_");
}

async function makeDb(opts: SchemaInitOptions): Promise<Kysely<any>> {
  const signer = new DsqlSigner({
    hostname: opts.hostname,
    region: opts.region,
    credentials: opts.credentials,
  });
  const token = await signer.getDbConnectAdminAuthToken();
  const pgPool = new pg.Pool({
    host: opts.hostname,
    port: 5432,
    database: "postgres",
    user: "admin",
    password: token,
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
  return new Kysely({ dialect: new PostgresDialect({ pool: pgPool }) });
}

/**
 * Idempotent CREATE ROLE for DSQL. DSQL has no DO blocks, so we pre-check
 * pg_roles and only run CREATE when the role is absent. `createSql` must be a
 * single statement (no trailing semicolon, no PL/pgSQL).
 */
async function ensureRole(
  db: Kysely<any>,
  rolname: string,
  createSql: string,
): Promise<void> {
  const existing = await sql<{ exists: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${rolname}) AS exists
  `.execute(db);
  if (existing.rows[0]?.exists) return;
  await sql.raw(createSql).execute(db);
}

/**
 * Apply the full shared-schema DDL. Each statement runs in its own implicit
 * transaction — see the DSQL note at the top of this file.
 */
export async function initializeSharedSchema(
  opts: SchemaInitOptions,
): Promise<void> {
  const installer = installerPgUser(opts.stackPrefix);

  const db = await makeDb(opts);
  try {
    // Roles first — subsequent GRANTs reference them.
    await ensureRole(db, "manager_ddl", `CREATE ROLE manager_ddl LOGIN`);
    await ensureRole(db, "user_data_owner", `CREATE ROLE user_data_owner`);
    await ensureRole(db, installer, `CREATE ROLE "${installer}" LOGIN`);

    const statements: string[] = [
      `CREATE SCHEMA IF NOT EXISTS shared`,

      `GRANT CREATE, USAGE ON SCHEMA shared TO manager_ddl`,
      `GRANT ALL PRIVILEGES ON SCHEMA shared TO user_data_owner`,

      // shared.records — single flat table for all shared data types.
      // parent_id is a plain text column: DSQL has no FK constraints, so the
      // app must clear/repoint dangling parent_id values on delete.
      // Every record is file-backed; no inline content column.
      `CREATE TABLE IF NOT EXISTS shared.records (
         id                 text        PRIMARY KEY,
         type               text        NOT NULL,
         created_at         text        NOT NULL,
         updated_at         text        NOT NULL,
         owner_id           text        NOT NULL,
         sync_status        text        NOT NULL DEFAULT 'pending_push',
         deleted_at         text,
         version            integer     NOT NULL DEFAULT 1,
         content_hash       text        NOT NULL,
         object_storage_key text        NOT NULL,
         mime_type          text        NOT NULL,
         size_bytes         bigint      NOT NULL,
         original_filename  text,
         origin_app_id      text        NOT NULL,
         parent_id          text
       )`,

      `ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT ALL ON TABLES TO user_data_owner`,
      `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA shared TO user_data_owner`,

      // shared.access_grants — source of truth for application-layer enforcement
      `CREATE TABLE IF NOT EXISTS shared.access_grants (
         app_id         text    NOT NULL,
         type_id        text    NOT NULL,
         access         text    NOT NULL,
         metadata_write boolean NOT NULL DEFAULT false,
         PRIMARY KEY (app_id, type_id)
       )`,
      `GRANT SELECT ON shared.access_grants TO PUBLIC`,
      `GRANT INSERT, UPDATE, DELETE ON shared.access_grants TO "${installer}"`,

      // shared.reclassifications — audit log for unknown→typed promotions
      `CREATE TABLE IF NOT EXISTS shared.reclassifications (
         record_id    text        NOT NULL,
         from_type    text        NOT NULL,
         to_type      text        NOT NULL,
         actor_app_id text        NOT NULL,
         at           timestamptz NOT NULL DEFAULT now()
       )`,

      // shared.s3_orphans — cleanup queue for post-promotion S3 DELETE failures
      `CREATE TABLE IF NOT EXISTS shared.s3_orphans (
         s3_key      text        PRIMARY KEY,
         detected_at timestamptz NOT NULL DEFAULT now()
       )`,

      // Per-type metadata tables, generated from @starkeep/core's CORE_TYPES.
      // record_id is logically an FK to shared.records(id); DSQL has no FK
      // constraints or ON DELETE CASCADE, so deletes must be performed in
      // application code (delete the metadata row alongside the records row).
      ...CORE_TYPES.map(pgMetadataDdl),

      // app_install_steps — per-step state for idempotent install/uninstall.
      `CREATE TABLE IF NOT EXISTS shared.app_install_steps (
         app_id     text        NOT NULL,
         step       text        NOT NULL,
         status     text        NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now(),
         error      text,
         PRIMARY KEY (app_id, step)
       )`,
      `GRANT INSERT, UPDATE, SELECT ON shared.app_install_steps TO "${installer}"`,

      // Control-plane tables. These are NOT shared across apps the way
      // shared.records is — they hold per-instance config consumed by the
      // cloud-data-server and access-control engine. See the refactor plan.
      `CREATE TABLE IF NOT EXISTS shared.access_policies (
         policy_id     text NOT NULL PRIMARY KEY,
         subject_type  text NOT NULL,
         subject_id    text NOT NULL,
         resource_type text NOT NULL,
         resource_id   text NOT NULL,
         permissions   text NOT NULL,
         granted_at    text NOT NULL,
         expires_at    text
       )`,

      // sharing_tokens lives cloud-side only — bearer credentials that
      // validate against an access policy. token_hash is the looked-up key;
      // the unhashed token is never persisted.
      `CREATE TABLE IF NOT EXISTS shared.sharing_tokens (
         token_id    text    NOT NULL PRIMARY KEY,
         token_hash  text    NOT NULL,
         policy_id   text    NOT NULL,
         created_at  text    NOT NULL,
         expires_at  text,
         max_uses    integer,
         usage_count integer NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX ASYNC IF NOT EXISTS idx_sharing_tokens_token_hash ON shared.sharing_tokens(token_hash)`,

      // type_registrations declare which app handles which shared type id.
      // Instance-local control plane; both local and cloud bootstrap their
      // own from app manifests on startup.
      `CREATE TABLE IF NOT EXISTS shared.type_registrations (
         type_id              text NOT NULL PRIMARY KEY,
         schema_json          text NOT NULL,
         schema_version       text NOT NULL,
         description          text NOT NULL,
         registered_by_app_id text NOT NULL,
         registered_at        text NOT NULL
       )`,
    ];

    for (const stmt of statements) {
      await sql.raw(stmt).execute(db);
    }
  } finally {
    await db.destroy();
  }
}
