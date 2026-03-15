import type { StarkeepId, HLCTimestamp, AnyRecord } from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";

export interface ChangeLogEntry {
  readonly changeId: StarkeepId;
  readonly recordId: StarkeepId;
  readonly operation: "create" | "update" | "delete";
  readonly timestamp: HLCTimestamp;
  readonly recordSnapshot: AnyRecord;
}

export interface ChangeLog {
  append(
    entry: Omit<ChangeLogEntry, "changeId">,
  ): Promise<ChangeLogEntry>;
  getChangesSince(timestamp: HLCTimestamp): Promise<ChangeLogEntry[]>;
  getLatestTimestamp(): Promise<HLCTimestamp | null>;
  prune(olderThan: HLCTimestamp): Promise<number>;
}

export interface SyncPullRequest {
  readonly sinceTimestamp: HLCTimestamp;
  readonly limit: number;
}

export interface SyncPullResponse {
  readonly changes: ChangeLogEntry[];
  readonly latestTimestamp: HLCTimestamp;
  readonly hasMore: boolean;
}

export interface SyncPushRequest {
  readonly changes: ChangeLogEntry[];
}

export interface SyncPushResponse {
  readonly accepted: StarkeepId[];
  readonly conflicts: ConflictResolution[];
  readonly latestTimestamp: HLCTimestamp;
}

export interface ConflictResolution {
  readonly recordId: StarkeepId;
  readonly localChange: ChangeLogEntry;
  readonly remoteChange: ChangeLogEntry;
  readonly winner: "local" | "remote";
  readonly resolvedRecord: AnyRecord;
}

export interface FileSyncManifest {
  readonly fileHash: string;
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
}

export interface FileSyncEngine {
  getFilesToPush(
    localStorage: ObjectStorageAdapter,
    remoteStorage: ObjectStorageAdapter,
    keys: string[],
  ): Promise<FileSyncManifest[]>;
  getFilesToPull(
    localStorage: ObjectStorageAdapter,
    remoteStorage: ObjectStorageAdapter,
    keys: string[],
  ): Promise<FileSyncManifest[]>;
  transferFile(
    manifest: FileSyncManifest,
    source: ObjectStorageAdapter,
    destination: ObjectStorageAdapter,
  ): Promise<void>;
}

export type ChangeEventType =
  | "remote-update-available"
  | "local-data-synced"
  | "conflict-detected";

export interface ChangeEvent {
  readonly eventType: ChangeEventType;
  readonly recordIds: StarkeepId[];
  readonly timestamp: HLCTimestamp;
}

export type ChangeListener = (event: ChangeEvent) => void;

export interface ChangeNotifier {
  subscribe(listener: ChangeListener): () => void;
  emit(event: ChangeEvent): void;
}

export interface SyncEngine {
  recordChange(
    operation: "create" | "update" | "delete",
    record: AnyRecord,
  ): Promise<void>;
  pull(): Promise<SyncPullResponse>;
  push(): Promise<SyncPushResponse>;
  fullSync(): Promise<{
    pulled: number;
    pushed: number;
    conflicts: number;
  }>;
  readonly changeLog: ChangeLog;
  readonly changeNotifier: ChangeNotifier;
}

export interface SyncEngineOptions {
  readonly localDatabaseAdapter: DatabaseAdapter;
  readonly remoteDatabaseAdapter: DatabaseAdapter;
  readonly localObjectStorage: ObjectStorageAdapter;
  readonly remoteObjectStorage: ObjectStorageAdapter;
  readonly clock: import("@starkeep/core").HLCClock;
}
