import type { DataRecord, StarkeepId } from "@starkeep/core";
import { serializeHLC, deserializeHLC, SyncStatus, createStarkeepId } from "@starkeep/core";

export interface PostgresRow {
  id: string;
  type: string;
  created_at: string;
  updated_at: string;
  owner_id: string;
  sync_status: string;
  deleted_at: string | null;
  version: number;
  content: Record<string, unknown> | string;
  content_hash: string | null;
  object_storage_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

export function recordToRow(record: DataRecord): PostgresRow {
  return {
    id: record.id,
    type: record.type,
    created_at: serializeHLC(record.createdAt),
    updated_at: serializeHLC(record.updatedAt),
    owner_id: record.ownerId,
    sync_status: record.syncStatus,
    deleted_at: record.deletedAt ? serializeHLC(record.deletedAt) : null,
    version: record.version,
    content: record.content,
    content_hash: record.contentHash,
    object_storage_key: record.objectStorageKey,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
  };
}

export function rowToRecord(row: PostgresRow): DataRecord {
  const content =
    typeof row.content === "string" ? JSON.parse(row.content) : row.content;

  return {
    id: createStarkeepId(row.id),
    kind: "data",
    type: row.type,
    createdAt: deserializeHLC(row.created_at),
    updatedAt: deserializeHLC(row.updated_at),
    ownerId: row.owner_id,
    syncStatus: row.sync_status as SyncStatus,
    deletedAt: row.deleted_at ? deserializeHLC(row.deleted_at) : null,
    version: row.version,
    content,
    contentHash: row.content_hash,
    objectStorageKey: row.object_storage_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
  };
}
