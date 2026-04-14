import type {
  StarkeepId,
  DataRecord,
  MetadataRecord,
  HLCClock,
  CreateDataRecordInput,
} from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type {
  GeneratingFunctionDefinition,
  GeneratorRegistry,
  DependencyGraph,
  MetadataEngine,
  GenerationResult,
} from "@starkeep/metadata-engine";
import type { MetadataSyncRecord } from "@starkeep/storage-adapter";
import type { UnifiedIndex, IndexQuery, IndexResult } from "@starkeep/index";
import type {
  AggregationEngine,
  AggregationResult,
  AggregationOptions,
} from "@starkeep/aggregations";
import type { SyncEngine, ChangeListener } from "@starkeep/sync-engine";
import type {
  AccessControlEngine,
  CreatePolicyInput,
  AccessPolicy,
  AccessCheckRequest,
  AccessCheckResult,
  SubjectType,
} from "@starkeep/access-control";
import type { SharedSpaceApi, ApiRequest, ApiResponse, ApiRouter, WebSocketConnection } from "@starkeep/shared-space-api";

export interface DataOperations {
  put(input: CreateDataRecordInput): Promise<DataRecord>;
  putWithFile(
    input: CreateDataRecordInput,
    file: Uint8Array,
    contentType?: string,
  ): Promise<DataRecord>;
  putWithLocalFile(
    input: CreateDataRecordInput,
    filePath: string,
    contentType?: string,
  ): Promise<DataRecord>;
  get(recordId: StarkeepId): Promise<DataRecord | null>;
  delete(recordId: StarkeepId): Promise<void>;
  query(params: { type?: string; filters?: import("@starkeep/storage-adapter").Filter[] }): Promise<DataRecord[]>;
}

export interface MetadataOperations {
  generate(
    generatorId: string,
    targetId: StarkeepId,
  ): Promise<GenerationResult>;
  generateAll(
    targetId: StarkeepId,
    dataType: string,
  ): Promise<GenerationResult[]>;
  getForRecord(targetId: StarkeepId): Promise<MetadataRecord[]>;
  /**
   * Write a metadata value directly for a `syncable` generator, bypassing the
   * staleness check and generator function. Use this for user-authored metadata
   * (e.g. a photo caption) where the value comes from user input rather than
   * from a computation over the data record.
   *
   * The generator must be registered at SDK init with `syncable: true`.
   */
  putDirect(
    targetId: StarkeepId,
    targetType: string,
    generatorId: string,
    value: Record<string, unknown>,
  ): Promise<MetadataSyncRecord>;
}

export interface IndexOperations {
  search(query: IndexQuery): Promise<IndexResult>;
}

export interface AggregationOperations {
  compute(options?: AggregationOptions): Promise<AggregationResult>;
}

export interface SyncOperations {
  push(): Promise<{ pushed: number; conflicts: number }>;
  pull(): Promise<{ pulled: number }>;
  fullSync(): Promise<{ pulled: number; pushed: number; conflicts: number }>;
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

export interface ApiOperations {
  readonly router: ApiRouter;
  handleRequest(request: ApiRequest): Promise<ApiResponse>;
  /**
   * Register a connected WebSocket client. Returns a cleanup function to call
   * when the connection closes. Requires a changeNotifier (i.e. sync must be
   * configured) otherwise this is a no-op unsubscribe.
   */
  handleWebSocketConnect(connection: WebSocketConnection): () => void;
}

export type { ApiRouter };

export type { WebSocketConnection };

/**
 * Ergonomic interface for per-app private storage.
 * All operations are automatically scoped to `<normalizedAppId>:private:*`.
 * Only available when the SDK is created with a `subject` of type `"app"`.
 */
export interface PrivateStoreOperations {
  /** Write a record under `<appId>:private:<subtype>`. */
  put(subtype: string, content?: Record<string, unknown>): Promise<DataRecord>;
  /** Read a record by ID (must be accessible to this app's private namespace). */
  get(recordId: StarkeepId): Promise<DataRecord | null>;
  /** Delete a record by ID (must be accessible to this app's private namespace). */
  delete(recordId: StarkeepId): Promise<void>;
}

export interface StarkeepSdk {
  readonly data: DataOperations;
  readonly metadata: MetadataOperations;
  readonly index: IndexOperations;
  readonly aggregations: AggregationOperations;
  readonly sync: SyncOperations | null;
  readonly accessControl: AccessControlOperations;
  readonly api: ApiOperations;
  /**
   * Scoped private storage for this app. Non-null only when the SDK is
   * created with `subject: { subjectType: "app", subjectId: "..." }`.
   */
  readonly privateStore: PrivateStoreOperations | null;
  close(): Promise<void>;
}

export interface StarkeepSdkOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly ownerId: string;
  readonly nodeId: string;
  readonly clock?: HLCClock;
  readonly remoteDatabaseAdapter?: DatabaseAdapter;
  readonly remoteObjectStorageAdapter?: ObjectStorageAdapter;
  readonly generators?: GeneratingFunctionDefinition[];
  /**
   * When provided, all database operations are wrapped with
   * `EnforcedDatabaseAdapter` using this subject's identity.
   * Required to enable `sdk.privateStore`.
   */
  readonly subject?: {
    readonly subjectType: SubjectType;
    readonly subjectId: string;
  };
}
