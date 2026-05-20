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
 * DDL is run by the dedicated install-DDL role, temporarily granted
 * dsql:DbConnectAdmin by Manager around each install/uninstall. The session
 * connects as the DSQL admin PG role.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import type { SharedTypeAccess, SyncableTable } from "@starkeep/admin-manifest";
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
    user: "admin",
    password: token,
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
  return new Kysely({ dialect: new PostgresDialect({ pool: pgPool }) });
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
  appSyncableTables: SyncableTable[] = [],
  appSyncableFilesEnabled: boolean = false,
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

    // App-specific syncable tables under the app's private schema.
    // Each table gets reserved `updated_at` (HLC-serialized) and `deleted_at`
    // columns for inline-HLC change tracking, plus an index on `updated_at`
    // for efficient pull scans.
    const schemaName = `app_${appId.replace(/-/g, "_")}`;
    for (const table of appSyncableTables) {
      const colDdl = table.columns
        .map((c) => {
          const pgType = DSQL_COLUMN_TYPES[c.type] ?? "text";
          const notNull = c.notNull || c.primaryKey ? " NOT NULL" : "";
          return `"${c.name}" ${pgType}${notNull}`;
        })
        .join(", ");
      const pks = table.columns.filter((c) => c.primaryKey).map((c) => `"${c.name}"`);
      const pkClause = pks.length > 0 ? `, PRIMARY KEY (${pks.join(", ")})` : "";
      await sql.raw(
        `CREATE TABLE IF NOT EXISTS ${schemaName}."${table.name}" (${colDdl}, "updated_at" text NOT NULL, "deleted_at" text${pkClause})`,
      ).execute(db);
      await sql.raw(
        `CREATE INDEX ASYNC IF NOT EXISTS "idx_${schemaName}_${table.name}_updated_at" ON ${schemaName}."${table.name}"("updated_at")`,
      ).execute(db);
      // Grant app role full DML on its own syncable tables.
      await sql.raw(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${schemaName}."${table.name}" TO ${pgRole}`,
      ).execute(db);
    }

    // Upsert namespace registry row so the pull path knows which tables exist.
    if (appSyncableTables.length > 0 || appSyncableFilesEnabled) {
      const tablesJson = JSON.stringify(
        appSyncableTables.map((t) => ({
          name: t.name,
          pkColumns: t.columns.filter((c) => c.primaryKey).map((c) => c.name),
        })),
      );
      await sql`
        INSERT INTO shared.app_syncable_namespaces (app_id, tables_json, files_enabled)
        VALUES (${appId}, ${tablesJson}, ${appSyncableFilesEnabled})
        ON CONFLICT (app_id) DO UPDATE
          SET tables_json = EXCLUDED.tables_json, files_enabled = EXCLUDED.files_enabled
      `.execute(db);
    }
  } finally {
    await db.destroy();
  }
}

const DSQL_COLUMN_TYPES: Record<string, string> = {
  text: "text",
  integer: "integer",
  real: "real",
  blob: "bytea",
  boolean: "boolean",
};

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
    await sql`DELETE FROM shared.app_syncable_namespaces WHERE app_id = ${appId}`.execute(db);
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
