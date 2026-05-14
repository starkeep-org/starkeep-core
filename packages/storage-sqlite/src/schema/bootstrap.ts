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
 *   - shared_records           — all shared data, all types
 *   - shared_access_grants     — per-app, per-type permissions (read by AccessControlEngine)
 *   - shared_app_registry      — installed apps + HMAC secrets
 *   - shared_app_install_steps — idempotent install/uninstall ledger
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
      sync_status TEXT NOT NULL DEFAULT 'local',
      deleted_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT,
      object_storage_key TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      original_filename TEXT,
      origin_app_id TEXT NOT NULL,
      parent_id TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_shared_records_type ON shared_records(type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_shared_records_origin_app ON shared_records(origin_app_id)");

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

  // Per-type metadata tables on parity with DSQL. Generated from CORE_TYPES so
  // adding a type or a column is a single edit in @starkeep/core's core-types.ts.
  for (const t of CORE_TYPES) {
    db.exec(sqliteMetadataDdl(t));
  }
}
