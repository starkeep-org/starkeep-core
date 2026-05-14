import type { StarkeepId } from "../identifiers/types.js";
import type { HLCClock } from "../hlc/types.js";
import { generateId } from "../identifiers/ulid.js";
import { type DataRecord, type MetadataRecord, SyncStatus } from "./types.js";

export interface CreateDataRecordInput {
  type: string;
  ownerId: string;
  originAppId: string;
  content?: Record<string, unknown>;
  contentHash?: string | null;
  objectStorageKey?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  originalFilename?: string | null;
  parentId?: StarkeepId | null;
}

export interface CreateMetadataRecordInput {
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
    originalFilename: input.originalFilename ?? null,
    content: input.content ?? {},
    originAppId: input.originAppId,
    parentId: input.parentId ?? null,
  };
}

export function createMetadataRecord(input: CreateMetadataRecordInput): MetadataRecord {
  return {
    targetId: input.targetId,
    generatorId: input.generatorId,
    generatorVersion: input.generatorVersion,
    inputHash: input.inputHash,
    value: input.value,
  };
}
