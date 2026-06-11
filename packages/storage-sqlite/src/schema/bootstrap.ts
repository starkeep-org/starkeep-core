import type { DatabaseSync } from "node:sqlite";
import { CATEGORIES, sqliteMetadataDdl } from "@starkeep/protocol-primitives";

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
 *   - shared_access_grants     — per-app, per-extension permissions
 *   - shared_app_registry      — installed apps + HMAC secrets
 *   - shared_app_install_steps — idempotent install/uninstall ledger
 *   - access_policies          — control-plane: AccessControlEngine policies
 *
 * `sharing_tokens` is not persisted anywhere today — local uses the disabled
 * stub store and no cloud-side table or endpoint exists. The redemption path
 * is left for a future workstream.
 *
 * No migration system: this is a fresh-start schema. The user removes
 * ~/.starkeep/data.db (or the local-data-server's STARKEEP_DIR is fresh)
 * before this code runs.
 */
export function initializeLocalSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      content_hash TEXT NOT NULL,
      object_storage_key TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      original_filename TEXT,
      origin_app_id TEXT NOT NULL,
      parent_id TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_shared_records_type ON shared_records(type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_shared_records_origin_app ON shared_records(origin_app_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_shared_records_parent_id ON shared_records(parent_id)");
  // Duplicate-file prevention: (filename + bytes) is unique among live records.
  // Tombstoned rows (deleted_at IS NOT NULL) are excluded so a re-upload after
  // delete is allowed. Records with NULL filename are not constrained — the
  // rule requires both filename and content to match.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_shared_records_filename_hash " +
      "ON shared_records(original_filename, content_hash) " +
      "WHERE deleted_at IS NULL AND original_filename IS NOT NULL",
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_access_grants (
      app_id TEXT NOT NULL,
      type_id TEXT NOT NULL,
      access TEXT NOT NULL CHECK (access IN ('read', 'readwrite')),
      metadata_write INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (app_id, type_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_shared_access_grants_app ON shared_access_grants(app_id)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_app_registry (
      app_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'app',
      manifest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'installing',
      hmac_secret TEXT NOT NULL,
      installed_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_app_install_steps (
      app_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('install', 'uninstall')),
      step TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
      error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (app_id, operation, step)
    )
  `);

  // App-specific syncable namespace registry. One row per installed app that
  // declared `infraRequirements.appSpecificSyncable`. Lists the tables the
  // installer materialized as `<app_id>_syncable_<name>` and whether the app
  // opted into the `apps/<app_id>/syncable/` file prefix. Read by the SDK to
  // gate row CRUD/file ops and by the sync engine to enumerate what to sync.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_syncable_namespaces (
      app_id        TEXT PRIMARY KEY,
      tables_json   TEXT NOT NULL,
      files_enabled INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Control-plane: access policies issued via sdk.accessControl.createPolicy.
  // Instance-local; never synced. See AccessControlEngine.
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_policies (
      policy_id     TEXT PRIMARY KEY,
      subject_type  TEXT NOT NULL,
      subject_id    TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id   TEXT NOT NULL,
      permissions   TEXT NOT NULL,
      granted_at    TEXT NOT NULL,
      expires_at    TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_access_policies_subject ON access_policies(subject_type, subject_id)");

  // Per-category metadata tables on parity with DSQL. Generated from CATEGORIES
  // so adding a category or a column is a single edit in @starkeep/protocol-primitives's
  // core-types.ts. `other` has no metadata columns and gets no table.
  for (const c of CATEGORIES) {
    if (c.id === "other") continue;
    db.exec(sqliteMetadataDdl(c));
  }
}
