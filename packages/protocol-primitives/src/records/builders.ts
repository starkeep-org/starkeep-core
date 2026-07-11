import type { StarkeepId } from "../identifiers/types.js";
import type { HLCClock } from "../hlc/types.js";
import { generateId } from "../identifiers/ulid.js";
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
  /**
   * Optional advisory `<appId>/<purpose>` label (e.g. `photos/thumbnail`).
   * Omitted/`null` for general-interest records. See `DataRecord.label`.
   */
  label?: string | null;
}

export function createDataRecord(input: CreateDataRecordInput, clock: HLCClock): DataRecord {
  const now = clock.now();
  return {
    id: generateId(),
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
    originalFilename: input.originalFilename ?? null,
    originAppId: input.originAppId,
    parentId: input.parentId ?? null,
    label: input.label ?? null,
  };
}
