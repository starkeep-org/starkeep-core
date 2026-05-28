import type { StarkeepId } from "../identifiers/types.js";
import type { HLCTimestamp } from "../hlc/types.js";

export interface BaseRecord {
  readonly id: StarkeepId;
  readonly type: string;
  readonly createdAt: HLCTimestamp;
  updatedAt: HLCTimestamp;
  readonly ownerId: string;
  deletedAt: HLCTimestamp | null;
  version: number;
}

/**
 * A row in the shared records table. Every DataRecord is backed by a file in
 * object storage (`objectStorageKey` + `contentHash`); typed metadata derived
 * from the file lives in the type-specific `record_<type>_metadata` table.
 *
 * App-level / user-authored fields that cannot be deterministically derived
 * from the file (titles, captions, edit provenance, etc.) live in app-private
 * storage, not on this row.
 */
export interface DataRecord extends BaseRecord {
  readonly kind: "data";
  contentHash: string;
  objectStorageKey: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string | null;
  /**
   * App identity that produced this record. Set by the data-server at write
   * time from the authenticated subject. Required on every write.
   */
  originAppId: string;
  /**
   * Optional parent record id (e.g. an `image` thumbnail's parent is its
   * original). Same type as the parent — typed-to-typed relations only.
   */
  parentId: StarkeepId | null;
}

/**
 * One row in a per-type metadata table (`shared_record_<type>_metadata` /
 * `shared.record_<type>_metadata`). Columns are declared by the type's entry
 * in `CORE_TYPES`. Every column other than `recordId` must be deterministically
 * derivable from the record's file bytes.
 */
export interface MetadataRow {
  recordId: StarkeepId;
  [column: string]: unknown;
}

export type AnyRecord = DataRecord;
