import type { StarkeepId, HLCTimestamp, AnyRecord } from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";

// ---------------------------------------------------------------------------
// Per-table schema info stored in the namespace registry so appliers can UPSERT
// by PK without re-consulting the manifest at apply time.
// ---------------------------------------------------------------------------

export interface AppSyncableTableInfo {
  readonly name: string;
  readonly pkColumns: string[];
}

export interface AppSyncableNamespace {
  readonly appId: string;
  readonly tables: AppSyncableTableInfo[];
  readonly filesEnabled: boolean;
  /** Derived from tables — convenience accessor. */
  readonly tableNames: string[];
}

export interface AppSyncableNamespaceStore {
  get(appId: string): AppSyncableNamespace | null;
  list(): AppSyncableNamespace[];
}

// ---------------------------------------------------------------------------
// App-syncable row wire type — used in push requests and pull responses.
// Not a ChangeLogEntry: no changeId, no kind discriminator.
// Both push and pull synthesize these inline by scanning updated_at per table.
// ---------------------------------------------------------------------------

export interface AppSyncableRowEntry {
  readonly timestamp: HLCTimestamp;
  readonly appId: string;
  /** Bare table name (no engine prefix on the wire). */
  readonly table: string;
  readonly op: "insert" | "update" | "delete";
  readonly row?: Record<string, unknown>;
  readonly where?: Record<string, unknown>;
}

export interface AppSyncableApplier {
  apply(entry: AppSyncableRowEntry): Promise<void> | void;
}

/** Optional capability that appliers can implement to support pull/push synthesis. */
export interface ScanCapableApplier extends AppSyncableApplier {
  scanSince(
    appId: string,
    table: string,
    sinceHlcStr: string,
  ): Promise<AppSyncableRowEntry[]>;
}

// ---------------------------------------------------------------------------
// Change-log entry — record-only. App-syncable rows are NOT logged here.
// ---------------------------------------------------------------------------

export interface ChangeLogEntry {
  readonly changeId: StarkeepId;
  readonly recordId: StarkeepId;
  readonly operation: "create" | "update" | "delete";
  readonly timestamp: HLCTimestamp;
  readonly recordSnapshot: AnyRecord;
  // Version the client believed was current when producing this change.
  // null for creates. Used by the server for optimistic concurrency control.
  readonly baseVersion: number | null;
}

export interface ChangeLog {
  append(entry: Omit<ChangeLogEntry, "changeId">): Promise<ChangeLogEntry>;
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
  readonly appSyncableRows: AppSyncableRowEntry[];
  readonly latestTimestamp: HLCTimestamp;
  readonly hasMore: boolean;
}

export interface SyncPushRequest {
  readonly changes: ChangeLogEntry[];
  readonly appSyncableRows?: AppSyncableRowEntry[];
}

export type RejectionReason =
  | "version-mismatch"
  | "deleted"
  | "not-found";

export interface RejectedChange {
  readonly recordId: StarkeepId;
  readonly clientChange: ChangeLogEntry;
  // Server's current record, or null if reason === "not-found".
  readonly serverRecord: AnyRecord | null;
  readonly reason: RejectionReason;
}

export interface SyncPushResponse {
  readonly accepted: StarkeepId[];
  readonly rejected: RejectedChange[];
  readonly latestTimestamp: HLCTimestamp;
}

export interface SyncTransport {
  pullChanges(request: SyncPullRequest): Promise<SyncPullResponse>;
  pushChanges(request: SyncPushRequest): Promise<SyncPushResponse>;
}

export interface SyncConflict {
  readonly recordId: StarkeepId;
  readonly local: AnyRecord;
  readonly server: AnyRecord | null;
  readonly source: "pull" | "push";
  readonly detectedAt: HLCTimestamp;
}

export interface FileSyncManifest {
  readonly fileHash: string;
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
  readonly mimeType?: string;
}

export interface FileEntry {
  readonly key: string;
  readonly mimeType?: string;
}

export interface FileSyncEngine {
  /** True if a transferFile for this key is currently running in this process. */
  isTransferInFlight(key: string): boolean;
  getFilesToPush(
    localStorage: ObjectStorageAdapter,
    remoteStorage: ObjectStorageAdapter,
    entries: FileEntry[],
  ): Promise<FileSyncManifest[]>;
  getFilesToPull(
    localStorage: ObjectStorageAdapter,
    remoteStorage: ObjectStorageAdapter,
    entries: FileEntry[],
  ): Promise<FileSyncManifest[]>;
  /**
   * Resolve true on a successful transfer (or if the source key is now present
   * at the destination). Resolves false if the transfer is already in flight
   * or the source file doesn't exist.
   */
  transferFile(
    manifest: FileSyncManifest,
    source: ObjectStorageAdapter,
    destination: ObjectStorageAdapter,
  ): Promise<boolean>;
}

export type ChangeEventType =
  | "remote-update-available"
  | "local-data-synced"
  | "local-change-recorded"
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

export interface SyncStateStore {
  // HLC cursor up to which we've successfully pulled remote changes.
  getPullCursor(): Promise<HLCTimestamp | null>;
  setPullCursor(ts: HLCTimestamp): Promise<void>;

  // HLC timestamp of the last local change-log entry successfully pushed.
  getPushCursor(): Promise<HLCTimestamp | null>;
  setPushCursor(ts: HLCTimestamp): Promise<void>;

  getHlcClockState(): Promise<{ wallTime: number; counter: number } | null>;
  setHlcClockState(state: { wallTime: number; counter: number }): Promise<void>;
}

export interface RecordChangeOptions {
  readonly baseVersion?: number | null;
}

export interface SyncEngine {
  recordChange(
    operation: "create" | "update" | "delete",
    record: AnyRecord,
    options?: RecordChangeOptions,
  ): Promise<void>;
  pull(): Promise<SyncPullResponse>;
  push(): Promise<SyncPushResponse>;
  /**
   * Scan local records in PendingFileUpload / PendingFileDownload and attempt
   * to satisfy the owed blob transfer in either direction. Idempotent and
   * cheap to call on every sync tick.
   */
  runFileTransferPass(): Promise<{
    uploaded: number;
    downloaded: number;
    failed: number;
  }>;
  fullSync(): Promise<{
    pulled: number;
    pushed: number;
    rejected: number;
  }>;
  getConflicts(): SyncConflict[];
  clearConflict(recordId: StarkeepId): void;
  readonly changeLog: ChangeLog;
  readonly changeNotifier: ChangeNotifier;
}

export interface SyncEngineOptions {
  readonly localDatabaseAdapter: DatabaseAdapter;
  readonly localObjectStorage: ObjectStorageAdapter;
  readonly remoteObjectStorage: ObjectStorageAdapter;
  readonly transport: SyncTransport;
  readonly clock: import("@starkeep/core").HLCClock;
  readonly changeLog?: ChangeLog;
  readonly syncState?: SyncStateStore;
  /**
   * Returns the list of `apps/<appId>/syncable/...` file keys to sync. Called
   * once per push/pull. Returning an empty list (or omitting this option)
   * preserves the previous behaviour where only record-attached blobs are
   * synced. The harness fills this in from `app_syncable_namespaces`.
   */
  readonly listAppSyncableFiles?: () => Promise<FileEntry[]>;
  /**
   * Provides the applier (for applying incoming pull rows) and namespace store
   * (for scanning pending rows on push). Without it, app-syncable rows in pull
   * responses are silently skipped and no app rows are sent on push.
   */
  readonly appSyncableSource?: {
    readonly namespaces: AppSyncableNamespaceStore;
    readonly applier: AppSyncableApplier & ScanCapableApplier;
  };
}
