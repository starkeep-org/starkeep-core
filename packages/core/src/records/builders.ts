import type { StarkeepId } from "../identifiers/types.js";
import type { HLCClock, HLCTimestamp } from "../hlc/types.js";
import { generateId } from "../identifiers/ulid.js";
import { type DataRecord, type MetadataRecord, SyncStatus } from "./types.js";

export interface CreateDataRecordInput {
  type: string;
  ownerId: string;
  payload?: Record<string, unknown>;
  contentHash?: string | null;
  objectStorageKey?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface CreateMetadataRecordInput {
  type: string;
  ownerId: string;
  targetId: StarkeepId;
  generatorId: string;
  generatorVersion: number;
  inputHash: string;
  value: Record<string, unknown>;
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
    syncStatus: SyncStatus.Local,
    deletedAt: null,
    version: 1,
    contentHash: input.contentHash ?? null,
    objectStorageKey: input.objectStorageKey ?? null,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes ?? null,
    payload: input.payload ?? {},
  };
}

export function createMetadataRecord(
  input: CreateMetadataRecordInput,
  clock: HLCClock,
): MetadataRecord {
  const now = clock.now();
  return {
    id: generateId(),
    kind: "metadata",
    type: input.type,
    createdAt: now,
    updatedAt: now,
    ownerId: input.ownerId,
    syncStatus: SyncStatus.Local,
    deletedAt: null,
    version: 1,
    targetId: input.targetId,
    generatorId: input.generatorId,
    generatorVersion: input.generatorVersion,
    inputHash: input.inputHash,
    value: input.value,
  };
}
