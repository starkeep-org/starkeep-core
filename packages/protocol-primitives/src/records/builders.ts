import type { StarkeepId } from "../identifiers/types.js";
import type { HLCClock } from "../hlc/types.js";
import { generateId } from "../identifiers/ulid.js";
import { contentAddressedId } from "../identifiers/content-id.js";
import { type DataRecord } from "./types.js";

export interface CreateDataRecordInput {
  type: string;
  originAppId: string;
  contentHash: string;
  objectStorageKey: string;
  /** Advisory MIME; `null`/omitted when the write path supplies none. */
  mimeType?: string | null;
  sizeBytes: number;
  originalFilename?: string | null;
  parentId?: StarkeepId | null;
}

export function createDataRecord(input: CreateDataRecordInput, clock: HLCClock): DataRecord {
  const now = clock.now();
  const originalFilename = input.originalFilename ?? null;
  return {
    // Content-addressed whenever the record falls under
    // `UNIQUE(original_filename, content_hash)`, so two nodes that produce the
    // same file produce the same row and sync merges them instead of hitting
    // the index. The filename check is that constraint's own partial predicate,
    // not a separate rule: a record with no filename is not constrained, so
    // nothing needs it to converge. See `identifiers/content-id.ts`.
    //
    // Every writer of a data record goes through here for exactly this reason —
    // two sites minting ids by different rules is the failure this prevents.
    id:
      originalFilename === null
        ? generateId()
        : contentAddressedId(originalFilename, input.contentHash),
    kind: "data",
    type: input.type,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
    contentHash: input.contentHash,
    objectStorageKey: input.objectStorageKey,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes,
    originalFilename,
    originAppId: input.originAppId,
    parentId: input.parentId ?? null,
  };
}
