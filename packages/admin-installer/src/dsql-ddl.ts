/**
 * DSQL / PostgreSQL DDL for the shared schema and per-app install/uninstall.
 *
 * All SQL is composed with Kysely (schema-builder API or sql`...` template
 * literals for statements Kysely doesn't model). The records-table query
 * builder in packages/storage-aurora-dsql also uses Kysely (compile-only,
 * DummyDriver) so the two sites share a single SQL builder.
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
import type { FileAccess, SyncableTable } from "@starkeep/admin-manifest";
import {
  APP_GRANTABLE_CATEGORIES,
  typeCategory,
  type Category,
} from "@starkeep/protocol-primitives";
import { FILE_RECORDS_TABLE, FILE_RECORDS_COLUMNS } from "@starkeep/shared-space-api";
import { retryOnAccessDenied, retryOnTransientDbError } from "./retry-on-access-denied";

/**
 * Flattens a manifest's fileAccess (+ fileAccessAll) into the per-type grants
 * written to `shared.access_grants` (one row per declared Starkeep type id),
 * and the distinct categories those grants imply (used for metadata-table
 * GRANTs). Drive's `fileAccessAll` cannot enumerate `other/*` types, so it
 * writes no per-type grant rows — its read/write authority is granted in the
 * runtime path by app-id — but it does imply every grantable category.
 */
interface TypeGrant {
  type: string;
  access: "read" | "readwrite";
  metadataWrite: boolean;
}

function flattenFileAccess(fileAccess: FileAccess[]): TypeGrant[] {
  const out: TypeGrant[] = [];
  for (const entry of fileAccess) {
    for (const type of entry.types) {
      out.push({ type, access: entry.access, metadataWrite: entry.metadataWrite });
    }
  }
  return out;
}

interface CategoryGrant {
  category: Category;
  /** True if any type in this category is writable. */
  write: boolean;
  /** True if any type in this category grants metadata write. */
  metadataWrite: boolean;
}

function categoriesFromGrants(grants: TypeGrant[], fileAccessAll: boolean): CategoryGrant[] {
  if (fileAccessAll) {
    // Drive: every grantable category, full access. `other` has no metadata
    // table so it is not in APP_GRANTABLE_CATEGORIES and needs no GRANT.
    return APP_GRANTABLE_CATEGORIES.map((category) => ({
      category,
      write: true,
      metadataWrite: true,
    }));
  }
  const byCategory = new Map<Category, CategoryGrant>();
  for (const g of grants) {
    const category = typeCategory(g.type);
    if (category === "other") continue; // no metadata table
    const existing = byCategory.get(category) ?? { category, write: false, metadataWrite: false };
    existing.write ||= g.access === "readwrite";
    existing.metadataWrite ||= g.metadataWrite || g.access === "readwrite";
    byCategory.set(category, existing);
  }
  return [...byCategory.values()];
}

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

// Row types are validated by the live DSQL schema at runtime; the dynamic
// record shape keeps the query builder usable across shared.* and app schemas.
type DdlDb = Record<string, Record<string, unknown>>;

async function makeDb(opts: DsqlDdlOptions): Promise<Kysely<DdlDb>> {
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
      // pg.Pool emits 'error' on an *idle* client whose connection dies (e.g. a
      // DSQL socket that times out between DDL statements). With no listener,
      // Node treats it as an unhandled 'error' event and crashes the process
      // (observed: `read ETIMEDOUT` aborting an uninstall mid-DDL). Swallow it
      // to a warning: the pool discards the dead client and the next statement
      // acquires a fresh one; a genuinely failed statement still rejects and is
      // handled by the retryOnTransientDbError wrapper around the DDL body.
      pgPool.on("error", (err) => {
        console.warn(
          `[diag] idle DSQL connection error (${opts.hostname}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
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
  fileAccess: FileAccess[],
  fileAccessAll: boolean,
  appSyncableTables: SyncableTable[] = [],
  appSyncableFilesEnabled: boolean = false,
): Promise<void> {
  const pgRole = appIdToPgRole(opts.stackPrefix, appId);
  // Every statement below is idempotent (IF [NOT] EXISTS, probe-then-act,
  // ON CONFLICT), so a transient DSQL drop mid-DDL can safely replay the whole
  // body on a fresh connection rather than failing the install.
  await retryOnTransientDbError(`install DDL ${appId}`, async () => {
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
      // of the load-bearing constraint in data-roles-and-permissions.md ("the app
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

      const grants = flattenFileAccess(fileAccess);
      const hasWriteAccess = fileAccessAll || grants.some((g) => g.access === "readwrite");
      if (hasWriteAccess) {
        await sql`GRANT INSERT, UPDATE, DELETE ON shared.records TO ${sql.raw(pgRole)}`.execute(db);
      }

      // Per-category metadata table grants. access_grants stays extension-keyed
      // (below); the metadata tables and the IAM ceiling are category-granular
      // (D3). `other` has no metadata table.
      const categoryGrants = categoriesFromGrants(grants, fileAccessAll);
      for (const cg of categoryGrants) {
        const metaTable = `shared.record_${cg.category}_metadata`;
        await sql`GRANT SELECT ON ${sql.raw(metaTable)} TO ${sql.raw(pgRole)}`.execute(db);
        if (cg.write || cg.metadataWrite) {
          await sql`GRANT INSERT, UPDATE ON ${sql.raw(metaTable)} TO ${sql.raw(pgRole)}`.execute(
            db,
          );
        }
      }

      // access_grants rows — one per declared Starkeep type (the exact app-layer
      // check). Drive (fileAccessAll) writes none: it cannot enumerate `other/*`
      // types, and its read/write authority is granted by app-id in the runtime
      // access path (see access-enforcer.ts).
      for (const g of grants) {
        await db
          .insertInto("shared.access_grants")
          .values({
            app_id: appId,
            type_id: g.type,
            access: g.access,
            metadata_write: g.metadataWrite,
          })
          .onConflict((oc) =>
            oc.columns(["app_id", "type_id"]).doUpdateSet((eb) => ({
              access: eb.ref("excluded.access"),
              metadata_write: eb.ref("excluded.metadata_write"),
            })),
          )
          .execute();
      }

      // App-specific syncable tables under the app's private schema.
      // Each table gets reserved `updated_at` (HLC-serialized), `node_id`
      // (denormalized from updated_at by the applier) and `deleted_at`
      // columns for inline-HLC change tracking, plus an index on `updated_at`
      // for efficient pull scans and one on (node_id, updated_at) for the
      // responder's per-node coverage watermark.
      const schemaName = `app_${appId.replace(/-/g, "_")}`;
      for (const table of appSyncableTables) {
        let tb = db.schema.createTable(`${schemaName}.${table.name}`).ifNotExists();
        for (const c of table.columns) {
          const pgType = DSQL_COLUMN_TYPES[c.type] ?? "text";
          tb = tb.addColumn(c.name, sql.raw(pgType), (col) =>
            c.notNull || c.primaryKey ? col.notNull() : col,
          );
        }
        tb = tb
          .addColumn("updated_at", "text", (col) => col.notNull())
          .addColumn("node_id", "text", (col) => col.notNull())
          .addColumn("deleted_at", "text");
        const pks = table.columns.filter((c) => c.primaryKey).map((c) => c.name);
        if (pks.length > 0) {
          tb = tb.addPrimaryKeyConstraint(`pk_${schemaName}_${table.name}`, pks as never[]);
        }
        await tb.execute();
        await sql
          .raw(
            `CREATE INDEX ASYNC IF NOT EXISTS "idx_${schemaName}_${table.name}_updated_at" ON ${schemaName}."${table.name}"("updated_at")`,
          )
          .execute(db);
        await sql
          .raw(
            `CREATE INDEX ASYNC IF NOT EXISTS "idx_${schemaName}_${table.name}_node_watermark" ON ${schemaName}."${table.name}"("node_id", "updated_at")`,
          )
          .execute(db);
        // Grant app role full DML on its own syncable tables.
        await sql
          .raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schemaName}."${table.name}" TO ${pgRole}`)
          .execute(db);
      }

      // Framework-owned reserved table for app-syncable file bookkeeping.
      // Created in the app's private schema when files are enabled. Same
      // updated_at/deleted_at HLC + GRANT pattern as the manifest-declared
      // syncable tables.
      if (appSyncableFilesEnabled) {
        let tb = db.schema.createTable(`${schemaName}.${FILE_RECORDS_TABLE}`).ifNotExists();
        for (const c of FILE_RECORDS_COLUMNS) {
          tb = tb.addColumn(c.name, c.type === "integer" ? "bigint" : "text", (col) =>
            c.notNull || c.primaryKey ? col.notNull() : col,
          );
        }
        tb = tb
          .addColumn("updated_at", "text", (col) => col.notNull())
          .addColumn("node_id", "text", (col) => col.notNull())
          .addColumn("deleted_at", "text");
        const reservedPks = FILE_RECORDS_COLUMNS.filter((c) => c.primaryKey).map((c) => c.name);
        if (reservedPks.length > 0) {
          tb = tb.addPrimaryKeyConstraint(
            `pk_${schemaName}_${FILE_RECORDS_TABLE}`,
            reservedPks as never[],
          );
        }
        await tb.execute();
        await sql
          .raw(
            `CREATE INDEX ASYNC IF NOT EXISTS "idx_${schemaName}_${FILE_RECORDS_TABLE}_updated_at" ON ${schemaName}."${FILE_RECORDS_TABLE}"("updated_at")`,
          )
          .execute(db);
        await sql
          .raw(
            `CREATE INDEX ASYNC IF NOT EXISTS "idx_${schemaName}_${FILE_RECORDS_TABLE}_node_watermark" ON ${schemaName}."${FILE_RECORDS_TABLE}"("node_id", "updated_at")`,
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
        await db
          .insertInto("shared.app_syncable_namespaces")
          .values({
            app_id: appId,
            tables_json: tablesJson,
            files_enabled: appSyncableFilesEnabled,
          })
          .onConflict((oc) =>
            oc.column("app_id").doUpdateSet((eb) => ({
              tables_json: eb.ref("excluded.tables_json"),
              files_enabled: eb.ref("excluded.files_enabled"),
            })),
          )
          .execute();
      }
    } finally {
      await db.destroy().catch(() => {});
    }
  });
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
  fileAccess: FileAccess[],
  fileAccessAll: boolean,
): Promise<void> {
  const pgRole = appIdToPgRole(opts.stackPrefix, appId);
  const schemaName = `app_${appId.replace(/-/g, "_")}`;
  // Idempotent throughout (REVOKE, DELETE, DROP IF EXISTS, probe-then-act), so a
  // transient DSQL drop mid-DDL replays cleanly on a fresh connection. This is
  // the path that flaked in the Tier-3 e2e with a raw `read ETIMEDOUT`.
  await retryOnTransientDbError(`uninstall DDL ${appId}`, async () => {
    const db = await makeDb(opts);
    try {
      await sql`REVOKE ALL ON shared.records FROM ${sql.raw(pgRole)}`.execute(db);

      const categoryGrants = categoriesFromGrants(flattenFileAccess(fileAccess), fileAccessAll);
      for (const cg of categoryGrants) {
        const metaTable = `shared.record_${cg.category}_metadata`;
        await sql`REVOKE ALL ON ${sql.raw(metaTable)} FROM ${sql.raw(pgRole)}`.execute(db);
      }

      // Schema-level USAGE on `shared` is granted on install (line ~157 of the
      // install DDL). Without this revoke, DROP ROLE trips PG 2BP01
      // ("privileges for schema shared"). Drop after table-level revokes so
      // nothing in `shared.*` still depends on the role.
      await sql`REVOKE USAGE ON SCHEMA shared FROM ${sql.raw(pgRole)}`.execute(db);

      await db.deleteFrom("shared.access_grants").where("app_id", "=", appId).execute();
      await db.deleteFrom("shared.app_syncable_namespaces").where("app_id", "=", appId).execute();
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
      await db.destroy().catch(() => {});
    }
  });
}

function appIdToPgRole(stackPrefix: string, appId: string): string {
  return `${stackPrefix}_app_${appId}`.toLowerCase().replace(/-/g, "_");
}
