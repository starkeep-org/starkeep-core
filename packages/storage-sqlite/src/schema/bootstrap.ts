import type { DatabaseSync } from "node:sqlite";
import { CORE_TYPES, sqliteMetadataDdl } from "@starkeep/core";

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
 *   - shared_record_<t>_metadata — per-type metadata rows (typed columns)
 *   - shared_access_grants     — per-app, per-type permissions
 *   - shared_app_registry      — installed apps + HMAC secrets
 *   - shared_app_install_steps — idempotent install/uninstall ledger
 *   - access_policies          — control-plane: AccessControlEngine policies
 *   - type_registrations       — control-plane: app-declared type metadata
 *
 * `sharing_tokens` lives cloud-side only (tokens are issued and validated by
 * the cloud-data-server against shared resources). See plan.
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
      owner_id TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'pending_push',
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
      app_id           TEXT PRIMARY KEY,
      table_names_json TEXT NOT NULL,
      files_enabled    INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
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

  // Control-plane: per-app type registrations bootstrapped on app install.
  // Instance-local; never synced.
  db.exec(`
    CREATE TABLE IF NOT EXISTS type_registrations (
      type_id              TEXT PRIMARY KEY,
      schema_json          TEXT NOT NULL,
      schema_version       TEXT NOT NULL,
      description          TEXT NOT NULL,
      registered_by_app_id TEXT NOT NULL,
      registered_at        TEXT NOT NULL
    )
  `);

  // Per-type metadata tables on parity with DSQL. Generated from CORE_TYPES so
  // adding a type or a column is a single edit in @starkeep/core's core-types.ts.
  for (const t of CORE_TYPES) {
    db.exec(sqliteMetadataDdl(t));
  }
}
