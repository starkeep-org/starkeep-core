import type { AppSyncableTableInfo } from "./types.js";
import { appSyncableTableInfo, type DeclaredColumn } from "./columns.js";

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

/**
 * One column of the reserved table.
 *
 * A `DeclaredColumn` with both flags required, and **not** a narrower type
 * union of its own. It used to be `"text" | "integer"`, which read as a
 * simplification and worked as a third column-type vocabulary: both installers
 * translated it with a hand-written ternary rather than through
 * `pgColumnType` / `sqliteColumnType`, and the two ternaries gave different
 * answers for one declared type. See the note on `size_bytes` below.
 */
export interface FileRecordsTableColumn extends DeclaredColumn {
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
  { name: "object_storage_key", type: "text", notNull: true, primaryKey: false },
  { name: "content_hash", type: "text", notNull: true, primaryKey: false },
  { name: "mime_type", type: "text", notNull: false, primaryKey: false },
  // `bigint`, matching the column the DSQL installer has always created and
  // matching `shared.records.size_bytes`, which holds the same quantity. It was
  // declared `integer` while the Postgres DDL hard-coded `bigint`, so the
  // declaration was false — and the read path converts by *declared* type, so
  // the false declaration is what left this column returning a string from the
  // cloud and a number locally. int4 would cap an app-private file at 2 GiB,
  // which is the wrong answer as well as the untrue one.
  { name: "size_bytes", type: "bigint", notNull: true, primaryKey: false },
  { name: "original_filename", type: "text", notNull: false, primaryKey: false },
  { name: "origin_app_id", type: "text", notNull: true, primaryKey: false },
  { name: "created_at", type: "text", notNull: true, primaryKey: false },
];

export const FILE_RECORDS_TABLE_INFO: AppSyncableTableInfo = appSyncableTableInfo(
  FILE_RECORDS_TABLE,
  FILE_RECORDS_COLUMNS,
);

/** Append the reserved table info to a namespace's tables list. */
export function withFileRecordsTable(
  tables: AppSyncableTableInfo[],
  filesEnabled: boolean,
): AppSyncableTableInfo[] {
  if (!filesEnabled) return tables;
  if (tables.some((t) => t.name === FILE_RECORDS_TABLE)) return tables;
  return [...tables, FILE_RECORDS_TABLE_INFO];
}
