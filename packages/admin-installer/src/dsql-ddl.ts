/**
 * DSQL / PostgreSQL DDL for the shared schema and per-app install/uninstall.
 *
 * All SQL is composed with Kysely (schema-builder API or sql`...` template
 * literals for statements Kysely doesn't model). Existing SQL in
 * packages/storage-aurora-dsql stays as-is — Kysely is adopted only here.
 *
 * IAM→PG mapping: ${StackPrefix}-app-<appId>-role → ${stackPrefix}_app_<appId>
 * (lowercased, hyphens → underscores).
 *
 * DDL is run by the app's own session (with a temp install policy), not by
 * Manager directly. The session connects as the ${stackPrefix}_installer PG role.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import type { SharedTypeAccess } from "@starkeep/admin-manifest";
import { CORE_TYPE_REGISTRY } from "@starkeep/admin-manifest";

export interface DsqlDdlOptions {
  hostname: string;
  region: string;
  stackPrefix: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

async function makeDb(opts: DsqlDdlOptions): Promise<Kysely<any>> {
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
    user: `${opts.stackPrefix}_installer`,
    password: token,
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
  return new Kysely({ dialect: new PostgresDialect({ pool: pgPool }) });
}

/**
 * Bootstrap DDL — run once after the first user-data stack deploy.
 * Creates all shared-schema tables and per-type metadata tables for every
 * core-registered type. Apps never run CREATE TABLE on shared.*.
 */
export async function runSharedSchemaDdl(opts: DsqlDdlOptions): Promise<void> {
  const db = await makeDb(opts);
  try {
    await sql`CREATE SCHEMA IF NOT EXISTS shared`.execute(db);

    // manager_ddl PG role — Manager's identity for future DDL migrations
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'manager_ddl') THEN
          CREATE ROLE manager_ddl LOGIN;
        END IF;
      END $$
    `.execute(db);
    await sql`GRANT CREATE, USAGE ON SCHEMA shared TO manager_ddl`.execute(db);

    // user_data_owner — reserved for Drive, not yet assumable
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'user_data_owner') THEN
          CREATE ROLE user_data_owner;
        END IF;
      END $$
    `.execute(db);
    await sql`GRANT ALL PRIVILEGES ON SCHEMA shared TO user_data_owner`.execute(db);

    // shared.records — single flat table for all shared data types
    await sql`
      CREATE TABLE IF NOT EXISTS shared.records (
        id            text        PRIMARY KEY,
        type          text        NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        origin_app_id text        NOT NULL,
        parent_id     text        REFERENCES shared.records(id) ON DELETE SET NULL,
        size_bytes    bigint      NOT NULL,
        mime_type     text        NOT NULL
      )
    `.execute(db);

    await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT ALL ON TABLES TO user_data_owner`.execute(db);
    await sql`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA shared TO user_data_owner`.execute(db);

    // shared.access_grants — source of truth for application-layer enforcement
    await sql`
      CREATE TABLE IF NOT EXISTS shared.access_grants (
        app_id         text    NOT NULL,
        type_id        text    NOT NULL,
        access         text    NOT NULL,
        metadata_write boolean NOT NULL DEFAULT false,
        PRIMARY KEY (app_id, type_id)
      )
    `.execute(db);
    await sql`GRANT SELECT ON shared.access_grants TO PUBLIC`.execute(db);
    await sql`
      GRANT INSERT, UPDATE, DELETE ON shared.access_grants
      TO ${sql.raw(`${opts.stackPrefix}_installer`)}
    `.execute(db);

    // shared.reclassifications — audit log for unknown→typed promotions
    await sql`
      CREATE TABLE IF NOT EXISTS shared.reclassifications (
        record_id    text        NOT NULL,
        from_type    text        NOT NULL,
        to_type      text        NOT NULL,
        actor_app_id text        NOT NULL,
        at           timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db);

    // shared.s3_orphans — cleanup queue for post-promotion S3 DELETE failures
    await sql`
      CREATE TABLE IF NOT EXISTS shared.s3_orphans (
        s3_key      text        PRIMARY KEY,
        detected_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db);

    // Per-type metadata tables — one per core-registered type (created at bootstrap)
    for (const typeId of CORE_TYPE_REGISTRY) {
      await createTypeMetadataTable(db, typeId);
    }

    // "unknown" holding-pen type — minimal metadata table
    await sql`
      CREATE TABLE IF NOT EXISTS shared.record_unknown_metadata (
        record_id text PRIMARY KEY REFERENCES shared.records(id) ON DELETE CASCADE
      )
    `.execute(db);

    // app_install_steps — tracks per-step state for idempotent install/uninstall
    await sql`
      CREATE TABLE IF NOT EXISTS shared.app_install_steps (
        app_id     text        NOT NULL,
        step       text        NOT NULL,
        status     text        NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        error      text,
        PRIMARY KEY (app_id, step)
      )
    `.execute(db);
    await sql`
      GRANT INSERT, UPDATE, SELECT ON shared.app_install_steps
      TO ${sql.raw(`${opts.stackPrefix}_installer`)}
    `.execute(db);
  } finally {
    await db.destroy();
  }
}

async function createTypeMetadataTable(db: Kysely<any>, typeId: string): Promise<void> {
  const tableName = `record_${typeId.replace(/-/g, "_")}_metadata`;
  if (typeId === "image") {
    await sql`
      CREATE TABLE IF NOT EXISTS shared.${sql.raw(tableName)} (
        record_id   text        PRIMARY KEY REFERENCES shared.records(id) ON DELETE CASCADE,
        width       integer,
        height      integer,
        captured_at timestamptz
      )
    `.execute(db);
  } else {
    // Generic metadata table for other core types
    await sql`
      CREATE TABLE IF NOT EXISTS shared.${sql.raw(tableName)} (
        record_id text PRIMARY KEY REFERENCES shared.records(id) ON DELETE CASCADE
      )
    `.execute(db);
  }
}

/**
 * Per-app install DDL. Run under the app's STS-assumed session.
 * Creates the app's PG role, private schema, and shared grants.
 */
export async function runAppInstallDdl(
  opts: DsqlDdlOptions,
  appId: string,
  sharedTypeAccess: SharedTypeAccess[],
  canIngestUnknown: boolean,
  canPromoteFromUnknown: boolean,
): Promise<void> {
  const pgRole = appIdToPgRole(opts.stackPrefix, appId);
  const db = await makeDb(opts);
  try {
    // Per-app PG role
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sql.lit(pgRole)}) THEN
          EXECUTE 'CREATE ROLE ' || quote_ident(${sql.lit(pgRole)}) || ' LOGIN';
        END IF;
      END $$
    `.execute(db);

    // App-private schema
    await sql`
      CREATE SCHEMA IF NOT EXISTS ${sql.raw(`app_${appId.replace(/-/g, "_")}`)}
      AUTHORIZATION ${sql.raw(pgRole)}
    `.execute(db);
    await sql`
      GRANT ALL PRIVILEGES ON SCHEMA ${sql.raw(`app_${appId.replace(/-/g, "_")}`)}
      TO ${sql.raw(pgRole)}
    `.execute(db);
    await sql`
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${sql.raw(`app_${appId.replace(/-/g, "_")}`)}
      GRANT ALL ON TABLES TO ${sql.raw(pgRole)}
    `.execute(db);

    // shared.records access
    await sql`GRANT USAGE ON SCHEMA shared TO ${sql.raw(pgRole)}`.execute(db);
    await sql`GRANT SELECT ON shared.records TO ${sql.raw(pgRole)}`.execute(db);

    const hasWriteAccess = sharedTypeAccess.some((e) => e.access === "readwrite");
    if (hasWriteAccess || canIngestUnknown) {
      await sql`GRANT INSERT, UPDATE, DELETE ON shared.records TO ${sql.raw(pgRole)}`.execute(db);
    }

    // Per-type metadata table grants
    const expandedAccess = expandWildcard(sharedTypeAccess);
    for (const entry of expandedAccess) {
      const metaTable = `shared.record_${entry.typeId.replace(/-/g, "_")}_metadata`;
      await sql`GRANT SELECT ON ${sql.raw(metaTable)} TO ${sql.raw(pgRole)}`.execute(db);
      if (entry.access === "readwrite" || entry.metadataWrite) {
        await sql`GRANT INSERT, UPDATE ON ${sql.raw(metaTable)} TO ${sql.raw(pgRole)}`.execute(db);
      }
    }

    // unknown type grants (ingest = write-only, promote = read-only)
    if (canIngestUnknown) {
      // INSERT access is already granted above via hasWriteAccess||canIngestUnknown
      // INSERT into access_grants
      await sql`
        INSERT INTO shared.access_grants (app_id, type_id, access, metadata_write)
        VALUES (${appId}, 'unknown', 'readwrite', false)
        ON CONFLICT (app_id, type_id) DO UPDATE SET access = 'readwrite'
      `.execute(db);
    }
    if (canPromoteFromUnknown) {
      await sql`GRANT SELECT ON shared.record_unknown_metadata TO ${sql.raw(pgRole)}`.execute(db);
      await sql`
        INSERT INTO shared.access_grants (app_id, type_id, access, metadata_write)
        VALUES (${appId}, 'unknown', 'read', false)
        ON CONFLICT (app_id, type_id) DO UPDATE SET access = 'read'
      `.execute(db);
    }

    // access_grants rows for declared sharedTypeAccess
    for (const entry of expandedAccess) {
      await sql`
        INSERT INTO shared.access_grants (app_id, type_id, access, metadata_write)
        VALUES (${appId}, ${entry.typeId}, ${entry.access}, ${entry.metadataWrite})
        ON CONFLICT (app_id, type_id) DO UPDATE
          SET access = EXCLUDED.access, metadata_write = EXCLUDED.metadata_write
      `.execute(db);
    }
  } finally {
    await db.destroy();
  }
}

/**
 * Per-app uninstall DDL. Revokes grants and drops the app schema + PG role.
 * Shared tables and their rows are NOT dropped.
 */
export async function runAppUninstallDdl(
  opts: DsqlDdlOptions,
  appId: string,
  sharedTypeAccess: SharedTypeAccess[],
): Promise<void> {
  const pgRole = appIdToPgRole(opts.stackPrefix, appId);
  const schemaName = `app_${appId.replace(/-/g, "_")}`;
  const db = await makeDb(opts);
  try {
    await sql`REVOKE ALL ON shared.records FROM ${sql.raw(pgRole)}`.execute(db);

    const expandedAccess = expandWildcard(sharedTypeAccess);
    for (const entry of expandedAccess) {
      const metaTable = `shared.record_${entry.typeId.replace(/-/g, "_")}_metadata`;
      await sql`REVOKE ALL ON ${sql.raw(metaTable)} FROM ${sql.raw(pgRole)}`.execute(db);
    }

    await sql`DELETE FROM shared.access_grants WHERE app_id = ${appId}`.execute(db);
    await sql`DROP SCHEMA IF EXISTS ${sql.raw(schemaName)} CASCADE`.execute(db);
    await sql`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = ${sql.lit(pgRole)}) THEN
          EXECUTE 'DROP ROLE ' || quote_ident(${sql.lit(pgRole)});
        END IF;
      END $$
    `.execute(db);
  } finally {
    await db.destroy();
  }
}

function appIdToPgRole(stackPrefix: string, appId: string): string {
  return `${stackPrefix}_app_${appId}`.toLowerCase().replace(/-/g, "_");
}

function expandWildcard(access: SharedTypeAccess[]): SharedTypeAccess[] {
  const result: SharedTypeAccess[] = [];
  for (const entry of access) {
    if (entry.typeId === "*") {
      for (const typeId of CORE_TYPE_REGISTRY) {
        result.push({ ...entry, typeId });
      }
      // "unknown" is explicitly excluded from wildcard expansion
    } else {
      result.push(entry);
    }
  }
  return result;
}
