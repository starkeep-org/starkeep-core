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

/**
 * Name of the framework-owned table holding the cloud's own bytes watermark
 * for the channel, created in every app's namespace on the cloud. Unlike
 * {@link FILE_RECORDS_TABLE} it never syncs: it is one node's statement about
 * its own storage. See `@starkeep/storage-aurora-dsql`, `byte-coverage.ts`.
 */
export const BYTE_COVERAGE_TABLE = "_starkeep_byte_coverage";

/**
 * Name of the framework-owned table holding the cloud's per-author watermark
 * for each synced table in the app's namespace, created in every app's
 * namespace on the cloud. Like {@link BYTE_COVERAGE_TABLE} it never syncs. See
 * `@starkeep/storage-aurora-dsql`, `node-watermarks.ts`.
 */
export const NODE_WATERMARKS_TABLE = "_starkeep_node_watermarks";

/** Tables apps may not declare via the manifest or write to directly. */
export const RESERVED_TABLE_NAMES = new Set<string>([
  FILE_RECORDS_TABLE,
  BYTE_COVERAGE_TABLE,
  NODE_WATERMARKS_TABLE,
]);

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
  // A serialized HLC (`serializeHLC`), stamped by the node that registered
  // the file, like `updated_at`. One format only: `GET /app-data/files`
  // converts it to an ISO instant for the caller.
  { name: "created_at", type: "text", notNull: true, primaryKey: false },
];

export const FILE_RECORDS_TABLE_INFO: AppSyncableTableInfo = appSyncableTableInfo(
  FILE_RECORDS_TABLE,
  FILE_RECORDS_COLUMNS,
);

/** A serialized HLC: hex wall time, hex counter, node id (`serializeHLC`). */
const SERIALIZED_HLC = /^[0-9a-f]+:[0-9a-f]+:.+$/;

/**
 * What is wrong with a file-index row's `created_at`, or `null` when the value
 * is a serialized HLC. The check is not `deserializeHLC`'s, because that one
 * splits on `:` alone: an ISO instant holds exactly two colons, passes, and
 * reads as a moment in 1970.
 */
export function fileIndexCreatedAtProblem(id: unknown, value: unknown): string | null {
  if (typeof value === "string" && SERIALIZED_HLC.test(value)) return null;
  return `File index row ${String(id)} has created_at ${JSON.stringify(value)}, not a serialized HLC`;
}

/**
 * Refuse a file-index row whose `created_at` is not a serialized HLC.
 *
 * Both appliers call this on every entry, so the check covers a row the node
 * registers itself and a row a peer ships over sync. The throw is the refusal:
 * the sync engine logs it, holds that author's watermark, and offers the row
 * again next round, as it does for any entry an applier refuses. An entry that
 * carries no `created_at`, such as a local delete, passes.
 */
export function requireWellFormedFileIndexRow(entry: {
  readonly table: string;
  readonly row?: Record<string, unknown>;
}): void {
  if (entry.table !== FILE_RECORDS_TABLE || entry.row === undefined) return;
  if (!("created_at" in entry.row)) return;
  const problem = fileIndexCreatedAtProblem(entry.row["id"], entry.row["created_at"]);
  if (problem !== null) throw new Error(problem);
}

/** Append the reserved table info to a namespace's tables list. */
export function withFileRecordsTable(
  tables: AppSyncableTableInfo[],
  filesEnabled: boolean,
): AppSyncableTableInfo[] {
  if (!filesEnabled) return tables;
  if (tables.some((t) => t.name === FILE_RECORDS_TABLE)) return tables;
  return [...tables, FILE_RECORDS_TABLE_INFO];
}
