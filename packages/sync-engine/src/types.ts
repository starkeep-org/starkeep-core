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
// App-syncable row wire type — the exchange protocol synthesizes these inline
// by scanning updated_at per table and filtering against the caller's
// watermarks.
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

/** Optional capability that appliers can implement to support exchange synthesis. */
export interface ScanCapableApplier extends AppSyncableApplier {
  scanSince(
    appId: string,
    table: string,
    sinceHlcStr: string,
  ): Promise<AppSyncableRowEntry[]>;
}

/**
 * A row read from the framework-owned `_starkeep_sync_records` table.
 * Mirrors the column shape declared in `@starkeep/shared-space-api`'s
 * `FILE_RECORDS_COLUMNS` plus the always-appended HLC bookkeeping columns.
 * The sync engine's file-transfer pass derives upload/download decisions
 * from blob presence (`localObjectStorage.has(key)`), not from any stored
 * status — there is no `sync_status` column on this row. See
 * `residency.ts` (`RecordResidency`, `residencyOf`) for the named derived
 * state, and `system-design.md` "Per-record residency" for the rationale.
 */
export interface FileRecordRow {
  readonly id: string;
  readonly object_storage_key: string;
  readonly content_hash: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly original_filename: string | null;
  readonly origin_app_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

/**
 * Reserved-table file-records source for the file-transfer pass. Scans rows
 * the channel knows about; the pass then decides upload/download based on
 * blob presence on each side.
 */
export interface FileRecordsApplier {
  scanFileRecords(appId: string): Promise<FileRecordRow[]>;
}

// ---------------------------------------------------------------------------
// Version-vector exchange protocol — each side maintains a per-channel
// { [nodeId]: HLC } map of "what I've seen per replica" and ships records the
// peer hasn't seen. Conflict resolution is pure HLC LWW on shared records.
// ---------------------------------------------------------------------------

export type Watermarks = Record<string /* nodeId */, HLCTimestamp>;

export interface SyncExchangeRequest {
  /** Caller's view of what it has seen per nodeId. */
  readonly watermarks: Watermarks;
  /** Records the caller believes the peer hasn't seen yet. */
  readonly records?: AnyRecord[];
  /** App-syncable row deltas the caller believes the peer hasn't seen. */
  readonly appSyncableRows?: AppSyncableRowEntry[];
  /** Max records the responder should ship in this round. */
  readonly limit?: number;
}

export interface SyncExchangeResponse {
  /** Records the caller hasn't seen (`updated_at > callerWatermarks[nodeId]`). */
  readonly records: AnyRecord[];
  /** Same delta logic per app schema. */
  readonly appSyncableRows: AppSyncableRowEntry[];
  readonly hasMore: boolean;
}

export interface SyncTransport {
  exchange(request: SyncExchangeRequest): Promise<SyncExchangeResponse>;
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
  | "local-change-recorded";

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
  /** Caller's "what I've seen per nodeId" — advanced by records actually applied from peers. */
  getWatermarks(): Promise<Watermarks>;
  setWatermarks(watermarks: Watermarks): Promise<void>;

  /**
   * Last-known peer-side watermarks, returned by the peer on the previous
   * exchange. Used by the caller to compute outbound deltas without an extra
   * round-trip. Defaults to {} on first exchange.
   */
  getPeerWatermarks(): Promise<Watermarks>;
  setPeerWatermarks(watermarks: Watermarks): Promise<void>;

  getHlcClockState(): Promise<{ wallTime: number; counter: number } | null>;
  setHlcClockState(state: { wallTime: number; counter: number }): Promise<void>;
}

export interface ExchangeResult {
  readonly applied: number;
  readonly shipped: number;
  readonly hasMore: boolean;
}

export interface SyncEngine {
  /**
   * One version-vector exchange round with the peer:
   *   1. Read own + last-known peer watermarks
   *   2. For each outbound record (peer hasn't seen): push its blob if any,
   *      then ship metadata. Blob push failure excludes that record from the
   *      round; peerWatermarks stays behind it for an automatic retry.
   *   3. For each inbound record: apply metadata, then pull its blob if any.
   *      Blob pull failure leaves own watermark behind it; next round the
   *      responder still ships it.
   *   4. Persist updated watermarks.
   */
  exchange(): Promise<ExchangeResult>;
  readonly changeNotifier: ChangeNotifier;
}

export interface SyncEngineOptions {
  readonly localDatabaseAdapter: DatabaseAdapter;
  readonly localObjectStorage: ObjectStorageAdapter;
  readonly remoteObjectStorage: ObjectStorageAdapter;
  readonly transport: SyncTransport;
  readonly clock: import("@starkeep/core").HLCClock;
  readonly syncState?: SyncStateStore;
  /**
   * Provides the applier (for applying incoming exchange rows) and namespace
   * store (for scanning local rows on the outbound side). Without it,
   * app-syncable rows are silently skipped on both directions.
   */
  readonly appSyncableSource?: {
    readonly namespaces: AppSyncableNamespaceStore;
    readonly applier: AppSyncableApplier & ScanCapableApplier & FileRecordsApplier;
  };
  /**
   * Max items per exchange round, applied to both the outbound local scan and
   * the inbound request limit. Default 1000. Tests use small values (e.g. 5)
   * to exercise multi-round pagination without seeding thousands of records;
   * production callers may tune this against poll frequency / throughput.
   */
  readonly pageLimit?: number;
}
