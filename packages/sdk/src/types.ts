import type {
  StarkeepId,
  DataRecord,
  HLCClock,
  CreateDataRecordInput,
  AnyRecord,
  MetadataRow,
  TypeRegistration,
} from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { IndexQuery, IndexResult } from "@starkeep/index";
import type {
  AggregationResult,
  AggregationOptions,
} from "@starkeep/aggregations";
import type {
  ChangeListener,
  SyncTransport,
  SyncConflict,
  SyncStateStore,
  ChangeLog,
} from "@starkeep/sync-engine";
import type {
  CreatePolicyInput,
  AccessPolicy,
  AccessCheckRequest,
  AccessCheckResult,
  SubjectType,
  AccessPolicyStore,
  SharingTokenStore,
} from "@starkeep/access-control";
import type { TypeRegistrationStore } from "@starkeep/core";
import type {
  ApiRequest,
  ApiResponse,
  ApiRouter,
  ApiSubject,
  AppSpecificOperations,
  WebSocketConnection,
} from "@starkeep/shared-space-api";

export type ConflictResolution =
  | { keep: "local" }
  | { keep: "server" }
  | { keep: "custom"; record: AnyRecord };

/**
 * Input to `data.putWithFile` / `data.putWithLocalFile` — the file-bytes /
 * content-hash / object-storage-key / size / mimeType are filled in by the
 * SDK from the supplied bytes, so callers only specify the metadata they
 * choose explicitly.
 */
export type DataPutInput = Omit<
  CreateDataRecordInput,
  "contentHash" | "objectStorageKey" | "mimeType" | "sizeBytes"
> & {
  /**
   * Optional per-type metadata row to write atomically with the records-table
   * row. Columns are defined by the type's entry in `CORE_TYPES`. The SDK
   * supplies the `recordId` itself — callers omit it.
   */
  metadata?: Omit<MetadataRow, "recordId">;
};

export interface DataOperations {
  putWithFile(
    input: DataPutInput,
    file: Uint8Array,
    contentType: string,
  ): Promise<DataRecord>;
  putWithLocalFile(
    input: DataPutInput,
    filePath: string,
    contentType: string,
  ): Promise<DataRecord>;
  get(recordId: StarkeepId): Promise<DataRecord | null>;
  /**
   * Update tracked record metadata (parentId, originalFilename, mimeType). All
   * data-bearing fields are derived from the underlying file; to change them,
   * upload a new file via `putWithFile`. The metadata row, if any, is updated
   * by `putMetadata`.
   */
  update(
    recordId: StarkeepId,
    patch: Partial<Pick<DataRecord, "originalFilename" | "parentId">>,
  ): Promise<DataRecord>;
  delete(recordId: StarkeepId): Promise<void>;
  query(params: { type?: string; filters?: import("@starkeep/storage-adapter").Filter[] }): Promise<DataRecord[]>;
  resolveConflict(
    recordId: StarkeepId,
    resolution: ConflictResolution,
  ): Promise<DataRecord | null>;

  /** Write (insert-or-replace) a per-type metadata row. */
  putMetadata(typeId: string, row: MetadataRow): Promise<void>;
  /** Read a per-type metadata row by recordId. */
  getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null>;
  /** Batch-read per-type metadata rows. */
  getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>>;
}

export interface IndexOperations {
  search(query: IndexQuery): Promise<IndexResult>;
}

export interface AggregationOperations {
  compute(options?: AggregationOptions): Promise<AggregationResult>;
}

export interface SyncOperations {
  push(): Promise<{ pushed: number; rejected: number }>;
  pull(): Promise<{ pulled: number }>;
  fullSync(): Promise<{ pulled: number; pushed: number; rejected: number }>;
  getConflicts(): SyncConflict[];
  onUpdate(listener: ChangeListener): () => void;
}

export interface AccessControlOperations {
  createPolicy(input: CreatePolicyInput): Promise<AccessPolicy>;
  revokePolicy(policyId: StarkeepId): Promise<void>;
  listPolicies(options?: {
    subjectId?: string;
    resourceId?: string;
  }): Promise<AccessPolicy[]>;
  checkAccess(request: AccessCheckRequest): Promise<AccessCheckResult>;
}

export interface TypeRegistrationOperations {
  /** Idempotent register-or-update. */
  register(registration: Omit<TypeRegistration, "registeredAt">): Promise<TypeRegistration>;
  get(typeId: string): Promise<TypeRegistration | null>;
  list(): Promise<TypeRegistration[]>;
}

export interface ApiOperations {
  readonly router: ApiRouter;
  handleRequest(request: ApiRequest): Promise<ApiResponse>;
  handleWebSocketConnect(connection: WebSocketConnection): () => void;
}

export type { ApiRouter };
export type { WebSocketConnection };

export interface StarkeepSdk {
  readonly data: DataOperations;
  readonly index: IndexOperations;
  readonly aggregations: AggregationOperations;
  readonly sync: SyncOperations | null;
  readonly accessControl: AccessControlOperations;
  readonly typeRegistrations: TypeRegistrationOperations;
  readonly api: ApiOperations;
  close(): Promise<void>;
}

export interface StarkeepSdkOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  /** Backing store for AccessPolicy rows (instance-local). */
  readonly accessPolicyStore: AccessPolicyStore;
  /**
   * Backing store for sharing tokens. Pass `disabledSharingTokenStore()` on
   * the local-data-server — tokens are issued and validated cloud-side.
   */
  readonly sharingTokenStore: SharingTokenStore;
  /** Backing store for TypeRegistration rows (instance-local). */
  readonly typeRegistrationStore: TypeRegistrationStore;
  readonly ownerId: string;
  readonly nodeId: string;
  readonly clock?: HLCClock;
  readonly syncTransport?: SyncTransport;
  readonly remoteObjectStorageAdapter?: ObjectStorageAdapter;
  readonly syncChangeLog?: ChangeLog;
  readonly syncStateStore?: SyncStateStore;
  readonly subject?: {
    readonly subjectType: SubjectType;
    readonly subjectId: string;
  };
  /**
   * Factory for the app-scoped app-specific operations exposed on the
   * ApiContext. Provided by the harness (local-data-server) since it owns
   * the syncable-namespace registry and storage layout.
   */
  readonly getAppSpecific?: (subject: ApiSubject) => AppSpecificOperations | null;
  /**
   * Returns the list of `apps/<appId>/syncable/...` file keys to include in
   * each push and pull cycle. Provided by the harness (local-data-server).
   * Omitting this option limits file sync to record-attached blobs only.
   */
  readonly listAppSyncableFiles?: () => Promise<import("@starkeep/sync-engine").FileEntry[]>;
  /**
   * Provides the applier and namespace store for app-syncable row sync.
   * Provided by the harness (local-data-server). Without it, app-syncable
   * rows are silently skipped on pull and omitted from push.
   */
  readonly appSyncableSource?: {
    readonly namespaces: import("@starkeep/sync-engine").AppSyncableNamespaceStore;
    readonly applier: import("@starkeep/sync-engine").AppSyncableApplier & import("@starkeep/sync-engine").ScanCapableApplier;
  };
}
