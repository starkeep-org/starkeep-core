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
  originalFilename: string | null;
  content: Record<string, unknown>;
}

/**
 * A metadata record is a lightweight value object derived from a data record
 * by a generator. It is stored in a per-type metadata table, not in the main
 * records table. There is one row per data record in each metadata table.
 */
export interface MetadataRecord {
  readonly targetId: StarkeepId;
  readonly generatorId: string;
  generatorVersion: number;
  inputHash: string;
  value: Record<string, unknown>;
}

export type AnyRecord = DataRecord;

/**
 * Stored as a DataRecord with type `@starkeep/type-registration`.
 * Only the admin layer (owner subject) may write these records.
 * `registeredByAppId` is provenance metadata only — it does not restrict
 * other apps from being granted access to the type.
 */
export interface TypeRegistration {
  /** Global type identifier, e.g. "media:photo" or "@starkeep/access-policy". */
  readonly typeId: string;
  /** JSON Schema for the record payload. */
  readonly schema: object;
  /** Semver string; increment on schema changes. */
  readonly schemaVersion: string;
  readonly description: string;
  readonly registeredAt: HLCTimestamp;
  /** Provenance only — does not imply ownership or exclusive access. */
  readonly registeredByAppId: string;
}
