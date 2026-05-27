import type { AppSyncableTableInfo } from "./types.js";

/**
 * Name of the framework-owned bookkeeping table created in every
 * `filesEnabled: true` app's namespace. Rows here mirror the shape of
 * `shared_records` (minus `type`, `version`, and `parent_id`) and ride the
 * normal app-syncable LWW pipeline. The sync engine — not the app — writes
 * this table; apps treat it as read-only metadata for filtering UIs.
 */
export const FILE_RECORDS_TABLE = "_starkeep_sync_records";

/** Tables apps may not declare via the manifest or write to directly. */
export const RESERVED_TABLE_NAMES = new Set<string>([FILE_RECORDS_TABLE]);

export interface FileRecordsTableColumn {
  readonly name: string;
  /** Maps to SQLite/PG types in the installer DDL. */
  readonly type: "text" | "integer";
  readonly notNull: boolean;
  readonly primaryKey: boolean;
}

/**
 * Column shape of the reserved file-records table. The installer DDL paths
 * (SQLite and DSQL) consume this directly. The `updated_at` / `deleted_at`
 * HLC columns are appended by the installer, just like for any app-syncable
 * table.
 */
export const FILE_RECORDS_COLUMNS: readonly FileRecordsTableColumn[] = [
  { name: "id", type: "text", notNull: true, primaryKey: true },
  { name: "sync_status", type: "text", notNull: true, primaryKey: false },
  { name: "object_storage_key", type: "text", notNull: true, primaryKey: false },
  { name: "content_hash", type: "text", notNull: true, primaryKey: false },
  { name: "mime_type", type: "text", notNull: true, primaryKey: false },
  { name: "size_bytes", type: "integer", notNull: true, primaryKey: false },
  { name: "original_filename", type: "text", notNull: false, primaryKey: false },
  { name: "origin_app_id", type: "text", notNull: true, primaryKey: false },
  { name: "created_at", type: "text", notNull: true, primaryKey: false },
];

export const FILE_RECORDS_TABLE_INFO: AppSyncableTableInfo = {
  name: FILE_RECORDS_TABLE,
  pkColumns: ["id"],
};

/** Append the reserved table info to a namespace's tables list. */
export function withFileRecordsTable(
  tables: AppSyncableTableInfo[],
  filesEnabled: boolean,
): AppSyncableTableInfo[] {
  if (!filesEnabled) return tables;
  if (tables.some((t) => t.name === FILE_RECORDS_TABLE)) return tables;
  return [...tables, FILE_RECORDS_TABLE_INFO];
}
