import type { HLCTimestamp, AnyRecord, DataRecord, MetadataRecord, StarkeepId } from "@starkeep/core";
import { serializeHLC, deserializeHLC, SyncStatus, createStarkeepId } from "@starkeep/core";

export interface SqliteRow {
  id: string;
  kind: string;
  type: string;
  created_at: string;
  updated_at: string;
  owner_id: string;
  sync_status: string;
  deleted_at: string | null;
  version: number;
  payload: string;
  content_hash: string | null;
  object_storage_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  target_id: string | null;
  generator_id: string | null;
  generator_version: number | null;
  input_hash: string | null;
  value: string | null;
}

export function recordToRow(record: AnyRecord): SqliteRow {
  const base = {
    id: record.id,
    kind: record.kind,
    type: record.type,
    created_at: serializeHLC(record.createdAt),
    updated_at: serializeHLC(record.updatedAt),
    owner_id: record.ownerId,
    sync_status: record.syncStatus,
    deleted_at: record.deletedAt ? serializeHLC(record.deletedAt) : null,
    version: record.version,
  };

  if (record.kind === "data") {
    return {
      ...base,
      payload: JSON.stringify(record.payload),
      content_hash: record.contentHash,
      object_storage_key: record.objectStorageKey,
      mime_type: record.mimeType,
      size_bytes: record.sizeBytes,
      target_id: null,
      generator_id: null,
      generator_version: null,
      input_hash: null,
      value: null,
    };
  }

  return {
    ...base,
    payload: "{}",
    content_hash: null,
    object_storage_key: null,
    mime_type: null,
    size_bytes: null,
    target_id: record.targetId,
    generator_id: record.generatorId,
    generator_version: record.generatorVersion,
    input_hash: record.inputHash,
    value: JSON.stringify(record.value),
  };
}

export function rowToRecord(row: SqliteRow): AnyRecord {
  const base = {
    id: createStarkeepId(row.id),
    type: row.type,
    createdAt: deserializeHLC(row.created_at),
    updatedAt: deserializeHLC(row.updated_at),
    ownerId: row.owner_id,
    syncStatus: row.sync_status as SyncStatus,
    deletedAt: row.deleted_at ? deserializeHLC(row.deleted_at) : null,
    version: row.version,
  };

  if (row.kind === "data") {
    return {
      ...base,
      kind: "data" as const,
      payload: JSON.parse(row.payload),
      contentHash: row.content_hash,
      objectStorageKey: row.object_storage_key,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
    } satisfies DataRecord;
  }

  return {
    ...base,
    kind: "metadata" as const,
    targetId: createStarkeepId(row.target_id!),
    generatorId: row.generator_id!,
    generatorVersion: row.generator_version!,
    inputHash: row.input_hash!,
    value: JSON.parse(row.value!),
  } satisfies MetadataRecord;
}
