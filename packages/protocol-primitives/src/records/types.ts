import type { StarkeepId } from "../identifiers/types.js";
import type { HLCTimestamp } from "../hlc/types.js";

export interface BaseRecord {
  readonly id: StarkeepId;
  /**
   * The record's lowercase file extension, verbatim (e.g. "jpg", "md", "xyz");
   * "" for extension-less files. This is the identification key. The derived
   * category (`categoryOf(type)`) determines the metadata table and storage
   * prefix; unmapped/empty extensions derive category "other".
   */
  readonly type: string;
  readonly createdAt: HLCTimestamp;
  updatedAt: HLCTimestamp;
  deletedAt: HLCTimestamp | null;
  version: number;
}

/**
 * A row in the shared records table. Every DataRecord is backed by a file in
 * object storage (`objectStorageKey` + `contentHash`); metadata derived from
 * the file lives in the per-category `record_<category>_metadata` table
 * (category = `categoryOf(type)`; `other` records have no metadata table).
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
   * Optional parent record id linking this record to another shared record
   * (e.g. a thumbnail's parent is its original). The parent may be of any
   * type; cross-type parent links are permitted.
   */
  parentId: StarkeepId | null;
}

/**
 * One row in a per-category metadata table (`shared_record_<category>_metadata`
 * / `shared.record_<category>_metadata`). Columns are declared by the
 * category's entry in `CATEGORIES`. Every column other than `recordId` must be
 * deterministically derivable from the record's file bytes.
 */
export interface MetadataRow {
  recordId: StarkeepId;
  [column: string]: unknown;
}

export type AnyRecord = DataRecord;
