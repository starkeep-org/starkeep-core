import type { StarkeepId } from "../identifiers/types.js";
import type { HLCTimestamp } from "../hlc/types.js";

export enum SyncStatus {
  Local = "local",
  Synced = "synced",
  PendingPush = "pending_push",
  PendingPull = "pending_pull",
  Conflict = "conflict",
}

export interface BaseRecord {
  readonly id: StarkeepId;
  readonly type: string;
  readonly createdAt: HLCTimestamp;
  updatedAt: HLCTimestamp;
  readonly ownerId: string;
  syncStatus: SyncStatus;
  deletedAt: HLCTimestamp | null;
  version: number;
}

export interface DataRecord extends BaseRecord {
  readonly kind: "data";
  contentHash: string | null;
  objectStorageKey: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  payload: Record<string, unknown>;
}

export interface MetadataRecord extends BaseRecord {
  readonly kind: "metadata";
  readonly targetId: StarkeepId;
  readonly generatorId: string;
  generatorVersion: number;
  inputHash: string;
  value: Record<string, unknown>;
}

export type AnyRecord = DataRecord | MetadataRecord;
