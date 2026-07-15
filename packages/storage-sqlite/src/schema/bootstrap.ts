import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { CATEGORIES, sqliteMetadataDdl } from "@starkeep/protocol-primitives";
import { compiler as qb } from "../query-builder.js";

/**
 * Local sqlite schema bootstrap.
 *
 * Layout follows desired-state-roles-and-permissions.md "DSQL DDL ... Local
 * SQLite asymmetry" section: prefix-named tables in one file instead of
 * separate schemas. Only tables that something in phase 1 actually reads or
 * writes are created here — promotion, metadata enrichment, and the janitor
 * land as separate workstreams with their own DDL.
 *
 *   - shared_records           — all shared data, all types (file-backed only)
 *   - shared_record_<category>_metadata — per-category metadata rows (typed columns)
 *   - shared_access_grants     — per-app, per-type permissions
 *   - shared_app_registry      — installed apps + HMAC secrets
 *   - shared_app_install_steps — idempotent install/uninstall ledger
 *
 * No migration system: this is a fresh-start schema. The user removes
 * ~/.starkeep/data.db (or the local-data-server's STARKEEP_DIR is fresh)
 * before this code runs.
 */
function applyLocalSchemaDdl(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // shared_records: node_id is denormalized from updated_at (its nodeId
  // component) on every write — it feeds the sync responder's per-node
  // coverage watermark via the (node_id, updated_at) index without scanning
  // the table. label is an advisory appId/purpose interest-filter marker
  // (e.g. photos/thumbnail); NULL = general interest. See DataRecord.label.
  db.exec(
    qb.schema
      .createTable("shared_records")
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
      .addColumn("size_bytes", "integer", (c) => c.notNull())
      .addColumn("original_filename", "text")
      .addColumn("origin_app_id", "text", (c) => c.notNull())
      .addColumn("parent_id", "text")
      .addColumn("label", "text")
      .compile().sql,
  );
  const sharedRecordsIndexes = [
    qb.schema.createIndex("idx_shared_records_type").ifNotExists().on("shared_records").column("type"),
    qb.schema
      .createIndex("idx_shared_records_node_watermark")
      .ifNotExists()
      .on("shared_records")
      .columns(["node_id", "updated_at"]),
    qb.schema
      .createIndex("idx_shared_records_origin_app")
      .ifNotExists()
      .on("shared_records")
      .column("origin_app_id"),
    qb.schema
      .createIndex("idx_shared_records_parent_id")
      .ifNotExists()
      .on("shared_records")
      .column("parent_id"),
    // Duplicate-file prevention: (filename + bytes) is unique among live
    // records. Tombstoned rows (deleted_at IS NOT NULL) are excluded so a
    // re-upload after delete is allowed. Records with NULL filename are not
    // constrained — the rule requires both filename and content to match.
    qb.schema
      .createIndex("uq_shared_records_filename_hash")
      .ifNotExists()
      .unique()
      .on("shared_records")
      .columns(["original_filename", "content_hash"])
      .where(sql.ref("deleted_at"), "is", null)
      .where(sql.ref("original_filename"), "is not", null),
  ];
  for (const index of sharedRecordsIndexes) {
    db.exec(index.compile().sql);
  }

  db.exec(
    qb.schema
      .createTable("shared_access_grants")
      .ifNotExists()
      .addColumn("app_id", "text", (c) => c.notNull())
      .addColumn("type_id", "text", (c) => c.notNull())
      .addColumn("access", "text", (c) => c.notNull().check(sql`access IN ('read', 'readwrite')`))
      .addColumn("metadata_write", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_at", "text", (c) => c.notNull().defaultTo(sql`(datetime('now'))`))
      .addPrimaryKeyConstraint("pk_shared_access_grants", ["app_id", "type_id"] as never[])
      .compile().sql,
  );
  db.exec(
    qb.schema
      .createIndex("idx_shared_access_grants_app")
      .ifNotExists()
      .on("shared_access_grants")
      .column("app_id")
      .compile().sql,
  );

  db.exec(
    qb.schema
      .createTable("shared_app_registry")
      .ifNotExists()
      .addColumn("app_id", "text", (c) => c.primaryKey())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("version", "text", (c) => c.notNull())
      .addColumn("tier", "text", (c) => c.notNull().defaultTo("app"))
      .addColumn("manifest", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull().defaultTo("installing"))
      .addColumn("hmac_secret", "text", (c) => c.notNull())
      .addColumn("installed_at", "text", (c) => c.notNull().defaultTo(sql`(datetime('now'))`))
      .addColumn("updated_at", "text", (c) => c.notNull().defaultTo(sql`(datetime('now'))`))
      .compile().sql,
  );

  db.exec(
    qb.schema
      .createTable("shared_app_install_steps")
      .ifNotExists()
      .addColumn("app_id", "text", (c) => c.notNull())
      .addColumn("operation", "text", (c) =>
        c.notNull().check(sql`operation IN ('install', 'uninstall')`),
      )
      .addColumn("step", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) =>
        c.notNull().check(sql`status IN ('pending', 'done', 'failed')`),
      )
      .addColumn("error", "text")
      .addColumn("updated_at", "text", (c) => c.notNull().defaultTo(sql`(datetime('now'))`))
      .addPrimaryKeyConstraint("pk_shared_app_install_steps", [
        "app_id",
        "operation",
        "step",
      ] as never[])
      .compile().sql,
  );

  // App-specific syncable namespace registry. One row per installed app that
  // declared `infraRequirements.appSpecificSyncable`. Lists the tables the
  // installer materialized as `<app_id>_syncable_<name>` and whether the app
  // opted into the `apps/<app_id>/syncable/` file prefix. Read by the SDK to
  // gate row CRUD/file ops and by the sync engine to enumerate what to sync.
  db.exec(
    qb.schema
      .createTable("app_syncable_namespaces")
      .ifNotExists()
      .addColumn("app_id", "text", (c) => c.primaryKey())
      .addColumn("tables_json", "text", (c) => c.notNull())
      .addColumn("files_enabled", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_at", "text", (c) => c.notNull().defaultTo(sql`(datetime('now'))`))
      .compile().sql,
  );

  // Per-category metadata tables on parity with DSQL. Generated from CATEGORIES
  // so adding a category or a column is a single edit in @starkeep/protocol-primitives's
  // core-types.ts. `other` has no metadata columns and gets no table.
  for (const c of CATEGORIES) {
    if (c.id === "other") continue;
    db.exec(sqliteMetadataDdl(c));
  }
}

export function initializeLocalSchema(db: DatabaseSync): void {
  try {
    applyLocalSchemaDdl(db);
  } catch (err) {
    // The DDL above is all `CREATE ... IF NOT EXISTS`, so it is a no-op against
    // an up-to-date DB and cannot fail on a fresh one. In practice the way it
    // DOES fail is a pre-existing DB written before a column was added: the
    // table already exists (so it is not recreated, and never gains the
    // column), and the first statement referencing the new column dies with a
    // bare "no such column: x". That message names the symptom, not the cause,
    // and the cause is the fresh-start contract in this file's header. Say so.
    throw new Error(
      `Local schema bootstrap failed: ${(err as Error).message}. This usually ` +
        `means the SQLite DB predates the current schema. There is no ` +
        `migration system by design — delete the DB ($STARKEEP_DIR/data.db, ` +
        `default ~/.starkeep/data.db) and it will be rebuilt on next start.`,
      { cause: err },
    );
  }
}
