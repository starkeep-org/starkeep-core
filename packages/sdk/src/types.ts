import type {
  StarkeepId,
  DataRecord,
  MetadataRecord,
  HLCClock,
  CreateDataRecordInput,
  AnyRecord,
} from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type {
  GeneratingFunctionDefinition,
  GenerationResult,
} from "@starkeep/metadata-engine";
import type { MetadataSyncRecord } from "@starkeep/storage-adapter";
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
} from "@starkeep/access-control";
import type { ApiRequest, ApiResponse, ApiRouter, WebSocketConnection } from "@starkeep/shared-space-api";

export type ConflictResolution =
  | { keep: "local" }
  | { keep: "server" }
  | { keep: "custom"; record: AnyRecord };

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
  update(
    recordId: StarkeepId,
    patch: Partial<Omit<DataRecord, "id" | "kind" | "createdAt" | "version">>,
  ): Promise<DataRecord>;
  delete(recordId: StarkeepId): Promise<void>;
  query(params: { type?: string; filters?: import("@starkeep/storage-adapter").Filter[] }): Promise<DataRecord[]>;
  /**
   * Resolve a sync conflict (OCC reject or local-dirty pull). `keep:"server"`
   * replaces the local record with the server's; `keep:"local"` rebases the
   * local change on top of the server's current version and queues a re-push;
   * `keep:"custom"` writes an arbitrary merged record.
   */
  resolveConflict(
    recordId: StarkeepId,
    resolution: ConflictResolution,
  ): Promise<DataRecord | null>;
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

export interface ApiOperations {
  readonly router: ApiRouter;
  handleRequest(request: ApiRequest): Promise<ApiResponse>;
  handleWebSocketConnect(connection: WebSocketConnection): () => void;
}

export type { ApiRouter };
export type { WebSocketConnection };

export interface PrivateStoreOperations {
  put(subtype: string, content?: Record<string, unknown>): Promise<DataRecord>;
  get(recordId: StarkeepId): Promise<DataRecord | null>;
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
  readonly privateStore: PrivateStoreOperations | null;
  close(): Promise<void>;
}

export interface StarkeepSdkOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly ownerId: string;
  readonly nodeId: string;
  readonly clock?: HLCClock;
  /** OCC sync transport to the remote (cloud) data-record endpoints. */
  readonly syncTransport?: SyncTransport;
  /** Object storage that the cloud is authoritative for, used for file sync. */
  readonly remoteObjectStorageAdapter?: ObjectStorageAdapter;
  /**
   * Optional direct remote adapter for metadata sync. Kept temporarily while
   * metadata sync still bypasses the transport abstraction.
   */
  readonly remoteDatabaseAdapter?: DatabaseAdapter;
  readonly syncChangeLog?: ChangeLog;
  readonly syncStateStore?: SyncStateStore;
  readonly generators?: GeneratingFunctionDefinition[];
  readonly subject?: {
    readonly subjectType: SubjectType;
    readonly subjectId: string;
  };
}
