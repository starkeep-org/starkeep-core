import type { StarkeepId } from "../identifiers/types.js";
import type { HLCClock } from "../hlc/types.js";
import { generateId } from "../identifiers/ulid.js";
import { type DataRecord, SyncStatus } from "./types.js";

export interface CreateDataRecordInput {
  type: string;
  ownerId: string;
  originAppId: string;
  contentHash: string;
  objectStorageKey: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename?: string | null;
  parentId?: StarkeepId | null;
}

export function createDataRecord(input: CreateDataRecordInput, clock: HLCClock): DataRecord {
  const now = clock.now();
  return {
    id: generateId(),
    kind: "data",
    type: input.type,
    createdAt: now,
    updatedAt: now,
    ownerId: input.ownerId,
    syncStatus: SyncStatus.PendingPush,
    deletedAt: null,
    version: 1,
    contentHash: input.contentHash,
    objectStorageKey: input.objectStorageKey,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    originalFilename: input.originalFilename ?? null,
    originAppId: input.originAppId,
    parentId: input.parentId ?? null,
  };
}
