import type {
  DataRecord,
  MetadataRow,
  StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  serializeHLC,
  deserializeHLC,
  createStarkeepId,
  isStandInRole,
  standInSlot,
} from "@starkeep/protocol-primitives";

export interface SqliteRow {
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
  stand_in_role: string | null;
  fidelity: number | null;
  canonical_threshold: number | null;
  /** Null on a row written before the column existed, which reads as false. */
  self_canonical: number | null;
  /**
   * Derived from the three columns above and `deleted_at` on every write — see
   * `standInSlot`. Never read back into a record: it exists only so one
   * ordinary unique index can carry both stand-in uniqueness rules.
   */
  stand_in_slot: string | null;
}

export function recordToRow(record: DataRecord): SqliteRow {
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
    stand_in_role: record.standInRole,
    fidelity: record.fidelity,
    canonical_threshold: record.canonicalThreshold,
    self_canonical: record.selfCanonical ? 1 : 0,
    stand_in_slot: standInSlot(record),
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
    standInRole: isStandInRole(row.stand_in_role) ? row.stand_in_role : null,
    // DSQL returns a bigint column as a string; the value is small, so a
    // Number is exact.
    fidelity: row.fidelity === null || row.fidelity === undefined ? null : Number(row.fidelity),
    canonicalThreshold:
      row.canonical_threshold === null || row.canonical_threshold === undefined
        ? null
        : Number(row.canonical_threshold),
    selfCanonical: row.self_canonical === 1,
  };
}

/**
 * Label rows are identical on both backends, so their row type and both
 * conversions live in `@starkeep/storage-adapter` — re-exported here for the
 * adapter that used to own them.
 */
export { rowToLabel, labelToRow, type LabelRow as SqliteLabelRow } from "@starkeep/storage-adapter";

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
