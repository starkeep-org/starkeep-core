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
import {
  FILE_RECORDS_TABLE,
  FILE_RECORDS_COLUMNS,
} from "@starkeep/shared-space-api";
import { retryOnAccessDenied } from "./retry-on-access-denied";

export interface DsqlDdlOptions {
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

async function makeDb(opts: DsqlDdlOptions): Promise<Kysely<any>> {
  // dsql:DbConnectAdmin is exercised at connect time when DSQL validates the
  // signed token against the caller's IAM policy. Manager has just attached
  // the temp-install-ddl-<appId> policy moments before this runs, and IAM
  // propagation to the DSQL data-plane authorizer is observed in the tens
  // of seconds — sometimes longer. Probing here with retry absorbs the
  // window cleanly; without it the very first DDL statement fails with an
  // opaque pg-shaped AccessDenied (see retry-on-access-denied.ts for the
  // pg-error detection we rely on).
  //
  // Each retry signs a fresh token so we don't wedge on an early-minted
  // token that DSQL might cache differently than later ones.
  return retryOnAccessDenied(
    `dsql:DbConnectAdmin ${opts.hostname}`,
    async () => {
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
      try {
        // Force an actual connection + round-trip. pg.Pool is lazy; without
        // this the propagation check would only fire on the first real query.
        await pgPool.query("SELECT 1");
      } catch (err) {
        // Don't leak the pool on the retry path. The retry helper will
        // re-enter this function and build a fresh pool on the next attempt.
        await pgPool.end().catch(() => {});
        throw err;
      }
      return new Kysely({ dialect: new PostgresDialect({ pool: pgPool }) });
    },
    { maxAttempts: 30, maxDelayMs: 10_000 },
  );
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
    // Per-app PG role. DSQL doesn't support anonymous PL/pgSQL DO blocks
    // (SQLSTATE 0A000 "unsupported statement: Do"), so idempotency is done
    // in two statements: probe pg_roles, then CREATE ROLE only if absent.
    // Concurrent installs of the same appId can't happen — the orchestrator
    // is serialized per app — so there's no race to defend against here.
    const existingRole = await sql<{ exists: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${pgRole}) AS exists
    `.execute(db);
    if (!existingRole.rows[0]?.exists) {
      await sql.raw(`CREATE ROLE "${pgRole}" LOGIN`).execute(db);
    }

    // DSQL's `admin` isn't a true Postgres superuser — `CREATE SCHEMA …
    // AUTHORIZATION <role>` requires the creating session to be able to
    // SET ROLE to the target. Grant admin membership in the app role so
    // ownership transfer is permitted. This goes the *opposite* direction
    // of the load-bearing constraint in roles-and-permissions.md ("the app
    // itself never holds DB admin"): admin gains membership in the app
    // role, not the other way around. Only install-ddl-role can reach
    // admin, so this membership is only exercised during install/uninstall.
    // Idempotent: re-granting an existing membership is a no-op in PG.
    await sql.raw(`GRANT "${pgRole}" TO admin`).execute(db);

    // DSQL-side IAM-to-PG mapping. CREATE ROLE LOGIN is not sufficient on its
    // own: DSQL has its own authorization layer that decides which IAM ARN may
    // log in as which PG role, separate from PG-level membership. Without this
    // grant the app's runtime sts:DbConnect attempts fail with an opaque
    // FATAL 28000 ("unable to accept connection, access denied", no hint).
    // Probe sys.iam_pg_role_mappings first because AWS IAM GRANT is not
    // idempotent in DSQL — re-granting an existing mapping errors.
    const appRoleArn = `arn:aws:iam::${opts.accountId}:role/${opts.stackPrefix}-app-${appId}-role`;
    const existingMapping = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM sys.iam_pg_role_mappings
        WHERE pg_role_name = ${pgRole} AND arn = ${appRoleArn}
      ) AS exists
    `.execute(db);
    if (!existingMapping.rows[0]?.exists) {
      await sql.raw(`AWS IAM GRANT "${pgRole}" TO '${appRoleArn}'`).execute(db);
    }

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

    // Framework-owned reserved table for app-syncable file bookkeeping.
    // Created in the app's private schema when files are enabled. Same
    // updated_at/deleted_at HLC + GRANT pattern as the manifest-declared
    // syncable tables.
    if (appSyncableFilesEnabled) {
      const reservedColDdl = FILE_RECORDS_COLUMNS.map((c) => {
        const pgType = c.type === "integer" ? "bigint" : "text";
        const notNull = c.notNull || c.primaryKey ? " NOT NULL" : "";
        return `"${c.name}" ${pgType}${notNull}`;
      }).join(", ");
      const reservedPks = FILE_RECORDS_COLUMNS.filter((c) => c.primaryKey)
        .map((c) => `"${c.name}"`)
        .join(", ");
      const reservedPkClause = reservedPks ? `, PRIMARY KEY (${reservedPks})` : "";
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS ${schemaName}."${FILE_RECORDS_TABLE}" (${reservedColDdl}, "updated_at" text NOT NULL, "deleted_at" text${reservedPkClause})`,
        )
        .execute(db);
      await sql
        .raw(
          `CREATE INDEX ASYNC IF NOT EXISTS "idx_${schemaName}_${FILE_RECORDS_TABLE}_updated_at" ON ${schemaName}."${FILE_RECORDS_TABLE}"("updated_at")`,
        )
        .execute(db);
      await sql
        .raw(
          `CREATE INDEX ASYNC IF NOT EXISTS "idx_${schemaName}_${FILE_RECORDS_TABLE}_sync_status" ON ${schemaName}."${FILE_RECORDS_TABLE}"("sync_status")`,
        )
        .execute(db);
      await sql
        .raw(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ${schemaName}."${FILE_RECORDS_TABLE}" TO ${pgRole}`,
        )
        .execute(db);
    }

    // Upsert namespace registry row so the pull path knows which tables exist.
    if (appSyncableTables.length > 0 || appSyncableFilesEnabled) {
      const tablesInfo = appSyncableTables.map((t) => ({
        name: t.name,
        pkColumns: t.columns.filter((c) => c.primaryKey).map((c) => c.name),
      }));
      if (appSyncableFilesEnabled) {
        tablesInfo.push({ name: FILE_RECORDS_TABLE, pkColumns: ["id"] });
      }
      const tablesJson = JSON.stringify(tablesInfo);
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

    // unknown metadata is granted on install when canPromoteFromUnknown but
    // is not part of expandedAccess, so the loop above misses it. Revoke
    // unconditionally — REVOKE on a non-existent grant is a no-op in PG.
    await sql`REVOKE ALL ON shared.record_unknown_metadata FROM ${sql.raw(pgRole)}`.execute(db);

    // Schema-level USAGE on `shared` is granted on install (line ~157 of the
    // install DDL). Without this revoke, DROP ROLE trips PG 2BP01
    // ("privileges for schema shared"). Drop after table-level revokes so
    // nothing in `shared.*` still depends on the role.
    await sql`REVOKE USAGE ON SCHEMA shared FROM ${sql.raw(pgRole)}`.execute(db);

    await sql`DELETE FROM shared.access_grants WHERE app_id = ${appId}`.execute(db);
    await sql`DELETE FROM shared.app_syncable_namespaces WHERE app_id = ${appId}`.execute(db);
    await sql`DROP SCHEMA IF EXISTS ${sql.raw(schemaName)} CASCADE`.execute(db);

    // Revoke the DSQL-side IAM mapping before DROP ROLE — DROP ROLE fails if
    // any AWS IAM GRANT still references it. Probe first because AWS IAM
    // REVOKE errors when the mapping is absent.
    const appRoleArn = `arn:aws:iam::${opts.accountId}:role/${opts.stackPrefix}-app-${appId}-role`;
    const existingMapping = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM sys.iam_pg_role_mappings
        WHERE pg_role_name = ${pgRole} AND arn = ${appRoleArn}
      ) AS exists
    `.execute(db);
    if (existingMapping.rows[0]?.exists) {
      await sql.raw(`AWS IAM REVOKE "${pgRole}" FROM '${appRoleArn}'`).execute(db);
    }

    // DSQL doesn't support DO blocks — same pattern as install: probe then act.
    const existingRole = await sql<{ exists: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${pgRole}) AS exists
    `.execute(db);
    if (existingRole.rows[0]?.exists) {
      await sql.raw(`DROP ROLE "${pgRole}"`).execute(db);
    }
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
