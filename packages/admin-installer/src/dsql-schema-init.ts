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
 *      (cloud-data-server's delete paths, etc.).
 *
 * If you add to this file, keep every entry to a single non-PL/pgSQL
 * statement with no FK constraints, and use the role-step pattern (or a
 * similar pre-check) for anything Postgres would normally express as
 * `IF NOT EXISTS ... DO`.
 */

import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { CATEGORIES, pgMetadataDdl } from "@starkeep/protocol-primitives";

export interface SchemaInitOptions {
  hostname: string;
  region: string;
  stackPrefix: string;
  accountId: string;
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

async function makeDb(opts: SchemaInitOptions): Promise<Kysely<Record<string, never>>> {
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
  db: Kysely<Record<string, never>>,
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

      // Duplicate-file prevention: (filename + bytes) is unique per owner
      // among live records. Tombstoned rows are excluded so re-upload after
      // delete is allowed. NULL filenames are not constrained — the rule
      // requires both filename and content to match.
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_records_owner_filename_hash
         ON shared.records (owner_id, original_filename, content_hash)
         WHERE deleted_at IS NULL AND original_filename IS NOT NULL`,

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

      // Per-category metadata tables, generated from @starkeep/protocol-primitives's
      // CATEGORIES. `other` has no metadata columns and gets no table.
      // record_id is logically an FK to shared.records(id); DSQL has no FK
      // constraints or ON DELETE CASCADE, so deletes must be performed in
      // application code (delete the metadata row alongside the records row).
      ...CATEGORIES.filter((c) => c.id !== "other").map((c) => pgMetadataDdl(c)),

      // app_install_steps — per-step state for idempotent install/uninstall.
      // PK is (app_id, operation, step): the same step name appears under
      // both `install` and `uninstall` (e.g. `attach_temp_install_ddl_policy`
      // is reused symmetrically by uninstall), so the operation must be part
      // of the key. Mirrors local/registry.ts's shared_app_install_steps in
      // sqlite.
      `CREATE TABLE IF NOT EXISTS shared.app_install_steps (
         app_id     text        NOT NULL,
         operation  text        NOT NULL,
         step       text        NOT NULL,
         status     text        NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now(),
         error      text,
         PRIMARY KEY (app_id, operation, step)
       )`,
      `GRANT INSERT, UPDATE, DELETE, SELECT ON shared.app_install_steps TO "${installer}"`,

      // app_registry — one row per installed cloud app. Source of truth for
      // "which apps are currently installed in this cloud stack" so the UI
      // can surface install state without probing AWS resources.
      `CREATE TABLE IF NOT EXISTS shared.app_registry (
         app_id       text        NOT NULL PRIMARY KEY,
         version      text        NOT NULL,
         name         text,
         installed_at timestamptz NOT NULL DEFAULT now(),
         updated_at   timestamptz NOT NULL DEFAULT now()
       )`,
      `GRANT INSERT, UPDATE, DELETE, SELECT ON shared.app_registry TO "${installer}"`,

      // App-specific syncable namespace registry. Mirrors the local SQLite
      // app_syncable_namespaces table. One row per installed app that declared
      // infraRequirements.appSpecificSyncable. The tables_json column is a JSON
      // array of { name, pkColumns } objects. Read by the pull path to
      // enumerate per-app tables for inline-HLC change synthesis.
      `CREATE TABLE IF NOT EXISTS shared.app_syncable_namespaces (
         app_id        text    NOT NULL PRIMARY KEY,
         tables_json   text    NOT NULL,
         files_enabled boolean NOT NULL DEFAULT false
       )`,
      `GRANT SELECT ON shared.app_syncable_namespaces TO PUBLIC`,
      `GRANT INSERT, UPDATE, DELETE ON shared.app_syncable_namespaces TO "${installer}"`,
    ];

    for (const stmt of statements) {
      await sql.raw(stmt).execute(db);
    }

    // DSQL-side IAM-to-PG mapping for the cloud install registry. The
    // orchestrator opens its registry connection as the admin-app IAM role
    // (federated entry point — the same identity the human admin used to
    // start the install) and authenticates to PG as `<stackPrefix>_installer`.
    // This is the only IAM-to-PG mapping the schema initializer sets up; the
    // per-app mappings are added by run_dsql_ddl during install.
    //
    // Probe sys.iam_pg_role_mappings first — AWS IAM GRANT is not idempotent
    // in DSQL (re-granting an existing mapping errors).
    const adminAppRoleArn =
      `arn:aws:iam::${opts.accountId}:role/${opts.stackPrefix}-app-admin-role`;
    const existingMapping = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM sys.iam_pg_role_mappings
        WHERE pg_role_name = ${installer} AND arn = ${adminAppRoleArn}
      ) AS exists
    `.execute(db);
    if (!existingMapping.rows[0]?.exists) {
      await sql
        .raw(`AWS IAM GRANT "${installer}" TO '${adminAppRoleArn}'`)
        .execute(db);
    }
  } finally {
    await db.destroy();
  }
}
