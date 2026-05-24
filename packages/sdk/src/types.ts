import type {
  StarkeepId,
  DataRecord,
  HLCClock,
  CreateDataRecordInput,
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
  ChangeLog,
  ChangeNotifier,
  SyncStateStore,
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
  readonly accessControl: AccessControlOperations;
  readonly typeRegistrations: TypeRegistrationOperations;
  readonly api: ApiOperations;
  /**
   * Append-only outbox of local record writes. The local-data-server's sync
   * supervisor consumes it (filtered per app by `originAppId`) to drive
   * per-app sync loops. Undefined when the SDK is constructed without a
   * change log (no sync).
   */
  readonly changeLog: ChangeLog | undefined;
  /**
   * Broadcast channel for record-level events. The SDK emits
   * `local-change-recorded` on every write; the sync supervisor forwards
   * `local-data-synced` and `conflict-detected` from its per-app engines
   * onto this same notifier so subscribers (sharedSpaceApi, SSE clients)
   * see one unified stream.
   */
  readonly changeNotifier: ChangeNotifier;
  /** The clock backing this SDK — exposed so the supervisor can share it. */
  readonly clock: HLCClock;
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
  /**
   * Optional append-only change log. If provided, every record write is
   * appended here for the sync supervisor (which lives outside the SDK) to
   * consume. Omitting it disables write logging — the SDK still works for
   * pure-local read/write without sync.
   */
  readonly changeLog?: ChangeLog;
  /**
   * Optional state store. The SDK uses it only to seed and persist HLC clock
   * state (one clock per node). Per-app pull/push cursors are owned by the
   * supervisor and never touched here.
   */
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
}
