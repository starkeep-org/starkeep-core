import type { StarkeepId } from "../identifiers/types.js";
import type { HLCTimestamp } from "../hlc/types.js";
import type { StandInRole } from "../stand-ins/rules.js";

export interface BaseRecord {
  readonly id: StarkeepId;
  /**
   * The record's canonical Starkeep type — a `<category>/<format>` id (e.g.
   * "image/jpeg", "document/markdown"); `other/other` for unmapped /
   * extension-less files. This is the identification key, declared by the
   * writing app. Its category prefix (`typeCategory(type)`) determines the
   * metadata table and storage prefix.
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
 * (category = `typeCategory(type)`; `other` records have no metadata table).
 *
 * App-level / user-authored fields that cannot be deterministically derived
 * from the file (titles, captions, edit provenance, etc.) live in app-private
 * storage, not on this row.
 */
export interface DataRecord extends BaseRecord {
  readonly kind: "data";
  contentHash: string;
  objectStorageKey: string;
  /**
   * Advisory MIME type, recorded only when a write path actually supplies one
   * (e.g. an over-the-network upload). `null` when unknown — notably the local
   * watcher, which has only a filename. Never authoritative for identity; the
   * serving edge falls back to `application/octet-stream` when this is null.
   */
  mimeType: string | null;
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
  /**
   * `canonical` or `smaller` when this record is a stand-in for its parent — a
   * lower-fidelity file that can replace the original for the person. Null on
   * every other record, including derived records such as poster frames, which
   * have a parent but cannot replace it. See `stand-ins/rules.ts`.
   */
  standInRole: StandInRole | null;
  /**
   * Reported fidelity on the category's axis — the long edge in pixels for
   * images and video, the bitrate in kbps for audio.
   *
   * Two readings, told apart by {@link standInRole}. On a stand-in it is the
   * stand-in's own fidelity, reported by the app that wrote it. On an original
   * it is the original's fidelity, reported by the app that wrote the original
   * or, failing that, by the first app to write a stand-in — and written by the
   * platform, so no app edits another app's record. Null when nobody has said.
   */
  fidelity: number | null;
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
