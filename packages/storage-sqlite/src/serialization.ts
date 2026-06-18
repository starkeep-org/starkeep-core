import type { DataRecord, MetadataRow, StarkeepId } from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC, createStarkeepId } from "@starkeep/protocol-primitives";

export interface SqliteRow {
  id: string;
  type: string;
  created_at: string;
  updated_at: string;
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

export function recordToRow(record: DataRecord): SqliteRow {
  return {
    id: record.id,
    type: record.type,
    created_at: serializeHLC(record.createdAt),
    updated_at: serializeHLC(record.updatedAt),
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

export function rowToRecord(row: SqliteRow): DataRecord {
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
 * Convert SQLite column-keyed row data into a MetadataRow keyed by recordId
 * plus camelCase or snake_case columns. We pass columns through as-is from
 * the DB so callers can address them however they prefer.
 */
export function metadataRowFromColumns(
  recordId: StarkeepId,
  columns: Record<string, unknown>,
): MetadataRow {
  const row: MetadataRow = { recordId };
  for (const [key, value] of Object.entries(columns)) {
    if (key === "record_id") continue;
    row[key] = value;
  }
  return row;
}
