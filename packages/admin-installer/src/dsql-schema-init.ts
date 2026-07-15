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
 *   4. Partial indexes (`CREATE INDEX ... WHERE ...`) → SQLSTATE 0A000
 *      "WHERE not supported for CREATE INDEX". Fold the predicate columns
 *      into the index key instead (DSQL allows multiple NULLs in a unique
 *      index, so nullable columns can preserve "ignore these rows" semantics).
 *
 *   5. Synchronous secondary indexes → SQLSTATE 0A000 "unsupported mode.
 *      please use CREATE INDEX ASYNC.". DSQL builds secondary indexes
 *      asynchronously and does not accept `IF NOT EXISTS` on the async form,
 *      so we pre-check pg_indexes — see `ensureIndex` below.
 *
 * If you add to this file, keep every entry to a single non-PL/pgSQL
 * statement with no FK constraints or partial-index predicates, and use the
 * role/index pre-check pattern for anything Postgres would normally express
 * as `IF NOT EXISTS ... DO`.
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
 * Idempotent CREATE INDEX ASYNC for DSQL. DSQL requires secondary indexes to
 * be built asynchronously and does not accept IF NOT EXISTS on the async
 * form, so we pre-check pg_indexes by name.
 */
async function ensureIndex(
  db: Kysely<Record<string, never>>,
  schemaname: string,
  indexname: string,
  createSql: string,
): Promise<void> {
  const existing = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = ${schemaname} AND indexname = ${indexname}
    ) AS exists
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

    const grantStatements: string[] = [
      `GRANT CREATE, USAGE ON SCHEMA shared TO manager_ddl`,
      `GRANT ALL PRIVILEGES ON SCHEMA shared TO user_data_owner`,
      // Installer connects as <stackPrefix>_installer to read/write the
      // install-step ledger and app registry, both in `shared`. Table grants
      // alone aren't enough — schema-level USAGE is required to resolve the
      // qualified names.
      `GRANT USAGE ON SCHEMA shared TO "${installer}"`,
      // PUBLIC needs USAGE too: shared.access_grants and
      // shared.app_syncable_namespaces are granted SELECT to PUBLIC below,
      // which is meaningless without schema USAGE.
      `GRANT USAGE ON SCHEMA shared TO PUBLIC`,
    ];

    await db.schema.createSchema("shared").ifNotExists().execute();
    for (const stmt of grantStatements) {
      await sql.raw(stmt).execute(db);
    }

    // shared.records — single flat table for all shared data types.
    // parent_id is a plain text column: DSQL has no FK constraints, so the
    // app must clear/repoint dangling parent_id values on delete.
    // Every record is file-backed; no inline content column.
    // node_id is denormalized from updated_at (its nodeId component) on every
    // write. Feeds the sync responder's per-node coverage watermark via the
    // (node_id, updated_at) index without scanning the table.
    await db.schema
      .createTable("shared.records")
      .ifNotExists()
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addColumn("node_id", "text", (c) => c.notNull())
      .addColumn("deleted_at", "text")
      .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
      .addColumn("content_hash", "text", (c) => c.notNull())
      .addColumn("object_storage_key", "text", (c) => c.notNull())
      .addColumn("mime_type", "text")
      .addColumn("size_bytes", "bigint", (c) => c.notNull())
      .addColumn("original_filename", "text")
      .addColumn("origin_app_id", "text", (c) => c.notNull())
      .addColumn("parent_id", "text")
      .addColumn("label", "text")
      .execute();

    await sql
      .raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT ALL ON TABLES TO user_data_owner`)
      .execute(db);
    await sql
      .raw(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA shared TO user_data_owner`)
      .execute(db);

    // shared.access_grants — source of truth for application-layer enforcement
    await db.schema
      .createTable("shared.access_grants")
      .ifNotExists()
      .addColumn("app_id", "text", (c) => c.notNull())
      .addColumn("type_id", "text", (c) => c.notNull())
      .addColumn("access", "text", (c) => c.notNull())
      .addColumn("metadata_write", "boolean", (c) => c.notNull().defaultTo(false))
      .addPrimaryKeyConstraint("access_grants_pkey", ["app_id", "type_id"] as never[])
      .execute();
    await sql.raw(`GRANT SELECT ON shared.access_grants TO PUBLIC`).execute(db);
    await sql
      .raw(`GRANT INSERT, UPDATE, DELETE ON shared.access_grants TO "${installer}"`)
      .execute(db);

    // Per-category metadata tables, generated from @starkeep/protocol-primitives's
    // CATEGORIES (plain-string DDL, executed via sql.raw). `other` has no
    // metadata columns and gets no table. record_id is logically an FK to
    // shared.records(id); DSQL has no FK constraints or ON DELETE CASCADE, so
    // deletes must be performed in application code (delete the metadata row
    // alongside the records row).
    for (const c of CATEGORIES.filter((c) => c.id !== "other")) {
      await sql.raw(pgMetadataDdl(c)).execute(db);
    }

    // app_install_steps — per-step state for idempotent install/uninstall.
    // PK is (app_id, operation, step): the same step name appears under
    // both `install` and `uninstall` (e.g. `attach_temp_install_ddl_policy`
    // is reused symmetrically by uninstall), so the operation must be part
    // of the key. Mirrors local/registry.ts's shared_app_install_steps in
    // sqlite.
    await db.schema
      .createTable("shared.app_install_steps")
      .ifNotExists()
      .addColumn("app_id", "text", (c) => c.notNull())
      .addColumn("operation", "text", (c) => c.notNull())
      .addColumn("step", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("error", "text")
      .addPrimaryKeyConstraint("app_install_steps_pkey", [
        "app_id",
        "operation",
        "step",
      ] as never[])
      .execute();
    await sql
      .raw(`GRANT INSERT, UPDATE, DELETE, SELECT ON shared.app_install_steps TO "${installer}"`)
      .execute(db);

    // app_registry — one row per installed cloud app. Source of truth for
    // "which apps are currently installed in this cloud stack" so the UI
    // can surface install state without probing AWS resources.
    await db.schema
      .createTable("shared.app_registry")
      .ifNotExists()
      .addColumn("app_id", "text", (c) => c.notNull().primaryKey())
      .addColumn("version", "text", (c) => c.notNull())
      .addColumn("name", "text")
      .addColumn("installed_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
    await sql
      .raw(`GRANT INSERT, UPDATE, DELETE, SELECT ON shared.app_registry TO "${installer}"`)
      .execute(db);

    // App-specific syncable namespace registry. Mirrors the local SQLite
    // app_syncable_namespaces table. One row per installed app that declared
    // infraRequirements.appSpecificSyncable. The tables_json column is a JSON
    // array of { name, pkColumns } objects. Read by the pull path to
    // enumerate per-app tables for inline-HLC change synthesis.
    await db.schema
      .createTable("shared.app_syncable_namespaces")
      .ifNotExists()
      .addColumn("app_id", "text", (c) => c.notNull().primaryKey())
      .addColumn("tables_json", "text", (c) => c.notNull())
      .addColumn("files_enabled", "boolean", (c) => c.notNull().defaultTo(false))
      .execute();
    await sql.raw(`GRANT SELECT ON shared.app_syncable_namespaces TO PUBLIC`).execute(db);
    await sql
      .raw(`GRANT INSERT, UPDATE, DELETE ON shared.app_syncable_namespaces TO "${installer}"`)
      .execute(db);

    // Duplicate-file prevention: (filename + bytes) is unique among live
    // records. DSQL doesn't support partial indexes (no `WHERE` on CREATE
    // INDEX), so we include `deleted_at` in the key and use NULLS NOT
    // DISTINCT (PG 15+) so two live rows with NULL deleted_at collide.
    // Tombstoned rows carry distinct HLC stamps in deleted_at so they don't
    // block re-upload after delete. NULL original_filename rows still don't
    // collide because the filename is part of the key and NULLS NOT DISTINCT
    // applies to the whole tuple, not per-column — but a NULL filename also
    // means "not a user-uploaded file" so dedup is moot for those.
    // DSQL requires CREATE INDEX ASYNC for secondary indexes.
    //
    // If DSQL rejects NULLS NOT DISTINCT, install fails loudly here and we
    // fall back to a sentinel-value scheme (see plan-cloud-auth-foundational
    // -fixes-2026-06-11.md).
    await ensureIndex(
      db,
      "shared",
      "uq_records_filename_hash",
      `CREATE UNIQUE INDEX ASYNC uq_records_filename_hash
         ON shared.records (original_filename, content_hash, deleted_at)
         NULLS NOT DISTINCT`,
    );

    // Backs the sync responder's per-node coverage watermark
    // (getNodeWatermarks): MAX(updated_at) GROUP BY node_id as an
    // index-only scan instead of a per-exchange table scan.
    await ensureIndex(
      db,
      "shared",
      "idx_records_node_watermark",
      `CREATE INDEX ASYNC idx_records_node_watermark
         ON shared.records (node_id, updated_at)`,
    );

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
