import type {
  Category,
  DataRecord,
  MetadataRow,
  StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  serializeHLC,
  deserializeHLC,
  createStarkeepId,
  getCategory,
  typeCategory,
} from "@starkeep/protocol-primitives";
import { pgConvertersFor } from "./pg-timestamps.js";

export interface PostgresRow {
  id: string;
  type: string;
  created_at: string;
  updated_at: string;
  /** Denormalized `updatedAt.nodeId`; must be rewritten with `updated_at`. */
  node_id: string;
  deleted_at: string | null;
  version: number;
  content_hash: string;
  object_storage_key: string;
  mime_type: string | null;
  size_bytes: number;
  original_filename: string | null;
  origin_app_id: string;
  parent_id: string | null;
}

export function recordToRow(record: DataRecord): PostgresRow {
  return {
    id: record.id,
    type: record.type,
    created_at: serializeHLC(record.createdAt),
    updated_at: serializeHLC(record.updatedAt),
    node_id: record.updatedAt.nodeId,
    deleted_at: record.deletedAt ? serializeHLC(record.deletedAt) : null,
    version: record.version,
    content_hash: record.contentHash,
    object_storage_key: record.objectStorageKey,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    original_filename: record.originalFilename,
    origin_app_id: record.originAppId,
    parent_id: record.parentId,
  };
}

export function rowToRecord(row: PostgresRow): DataRecord {
  return {
    id: createStarkeepId(row.id),
    kind: "data",
    type: row.type,
    createdAt: deserializeHLC(row.created_at),
    updatedAt: deserializeHLC(row.updated_at),
    deletedAt: row.deleted_at ? deserializeHLC(row.deleted_at) : null,
    version: row.version,
    contentHash: row.content_hash,
    objectStorageKey: row.object_storage_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    originalFilename: row.original_filename,
    originAppId: row.origin_app_id,
    parentId: row.parent_id ? createStarkeepId(row.parent_id) : null,
  };
}

/**
 * Label rows are identical on both backends, so their row type and both
 * conversions live in `@starkeep/storage-adapter` — re-exported here for the
 * adapter that used to own them.
 */
export { rowToLabel, labelToRow, type LabelRow as PostgresLabelRow } from "@starkeep/storage-adapter";

/**
 * One stored metadata row, with Postgres' renderings turned back into the
 * shapes the columns declare.
 *
 * The read half of the `timestamp` and `bigint` boundaries, and the exact
 * counterpart of the boolean conversion `columnsToMetadataRow` performs on
 * SQLite. A metadata row rides the sync wire in whatever shape its engine
 * returned, so a conversion this path skips is a conversion no later path
 * applies: without it `captured_at` leaves the cloud as Postgres'
 * `YYYY-MM-DD HH:MM:SS`, which every reader downstream parses as *local* time
 * and every node then holds four hours late.
 *
 * The same {@link pgConvertersFor} every other read on this backend runs
 * through, driven by the category's declared metadata columns rather than by a
 * second list of column names kept here.
 */
export function columnsToMetadataRow(
  recordId: StarkeepId,
  typeId: string,
  columns: Record<string, unknown>,
): MetadataRow {
  const category = typeCategory(typeId) ?? (typeId as Category);
  const converters = pgConvertersFor(getCategory(category)?.metadataColumns);
  const row: MetadataRow = { recordId };
  for (const [key, value] of Object.entries(columns)) {
    if (key === "record_id") continue;
    const convert = converters?.get(key);
    row[key] = convert ? convert(value) : value;
  }
  return row;
}
