import type {
  DataRecord,
  MetadataRow,
  RecordLabel,
  StarkeepId,
} from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC, createStarkeepId } from "@starkeep/protocol-primitives";

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
  label: string | null;
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
    label: record.label,
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
    label: row.label,
  };
}

export interface PostgresLabelRow {
  record_id: string;
  app_id: string;
  key: string;
  value: string | null;
  record_type: string;
  created_at: string;
  updated_at: string;
  node_id: string;
  deleted_at: string | null;
}

export function rowToLabel(row: PostgresLabelRow): RecordLabel {
  return {
    recordId: createStarkeepId(row.record_id),
    appId: row.app_id,
    key: row.key,
    value: row.value,
    recordType: row.record_type,
    createdAt: deserializeHLC(row.created_at),
    updatedAt: deserializeHLC(row.updated_at),
    nodeId: row.node_id,
    deletedAt: row.deleted_at ? deserializeHLC(row.deleted_at) : null,
  };
}

export function labelToRow(label: RecordLabel): PostgresLabelRow {
  return {
    record_id: label.recordId,
    app_id: label.appId,
    key: label.key,
    value: label.value,
    record_type: label.recordType,
    created_at: serializeHLC(label.createdAt),
    updated_at: serializeHLC(label.updatedAt),
    node_id: label.updatedAt.nodeId,
    deleted_at: label.deletedAt ? serializeHLC(label.deletedAt) : null,
  };
}

export function columnsToMetadataRow(
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
