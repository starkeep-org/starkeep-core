export type {
  AppSyncableRowEntry,
  AppSyncableApplier,
  ScanCapableApplier,
  ScanSincePage,
  SyncTransport,
  FileSyncManifest,
  FileEntry,
  FileSyncEngine,
  ChangeEventType,
  ChangeEvent,
  ChangeListener,
  ChangeNotifier,
  SyncEngine,
  SyncEngineOptions,
  SyncStateStore,
  AppSyncableTableInfo,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  FileRecordRow,
  Watermarks,
  SyncExchangeRequest,
  SyncExchangeResponse,
  ExchangeResult,
  ExchangeOptions,
  SyncOptions,
  SyncResult,
  VerifyResult,
  ResidencyDecider,
  ResidencyHooks,
} from "./types.js";
export {
  computeCeilings,
  cutRound,
  type RoundBudget,
  type RoundItem,
  type CutResult,
  type StreamTruncation,
} from "./round-cut.js";

export {
  decideResidency,
  validateRetentionPolicy,
  type KeepRule,
  type SizeClassRetention,
  type NodeRetentionPolicy,
  type RecordConstraints,
  type LocalOverrides,
  type BlobCandidate,
  type ResidencyDecision,
  type ResidencyVerdict,
  type ClassUsageLookup,
  type DecideResidencyInputs,
} from "./residency-policy.js";

export {
  createSqliteResidentSetIndex,
  type ResidentEntry,
  type ResidentSetIndex,
  type EvictionCandidateQuery,
} from "./resident-set.js";

export {
  assessDurability,
  type ReplicaProbe,
  type ReplicaState,
  type ReplicaReport,
  type DurabilityPolicy,
  type DurabilityVerdict,
  type DurabilityQuery,
} from "./durability.js";

export {
  evictClass,
  previewBudgetReduction,
  shedLoad,
  SHED_ORDER,
  DEFAULT_WATER_MARKS,
  type WaterMarks,
  type RetentionReason,
  type EvictionOutcome,
  type EvictionRequest,
  type ReductionPreview,
  type ShedStep,
} from "./eviction.js";

export { createSqliteSyncStateStore } from "./sync-state-sqlite.js";
export { createChangeNotifier } from "./change-notifier.js";
export { advanceWatermark, mergeWatermarks, watermarkFor, selectUnseen } from "./watermarks.js";
export { createFileSyncEngine } from "./file-sync-engine.js";
export { createSyncEngine } from "./sync-engine.js";
export { residencyOf, type RecordResidency } from "./residency.js";
export { createInProcessSyncTransport } from "./transports/in-process-transport.js";
export {
  createHttpSyncTransport,
  type HttpSyncTransportOptions,
} from "./transports/http-transport.js";
/**
 * The remote side of blob transfer, over the same signed HTTP the transport
 * uses. Exported because a node that syncs metadata but cannot move bytes is
 * not syncing — and because the phone needs exactly this and lives outside
 * this workspace, which is why it moved here from `apps/local-data-server`.
 */
export {
  HttpObjectStorageAdapter,
  type HttpObjectStorageAdapterOptions,
  type UploadFile,
} from "./transports/http-object-storage.js";
export {
  createHttpSyncHandler,
  type HttpSyncServerOptions,
} from "./transports/http-server.js";
export { SyncError } from "./errors.js";

export {
  projectPolicy,
  projectRow,
  selectedBytesFor,
  formatBytes,
  type SizeClassCensus,
  type RowProjection,
  type PolicyProjection,
} from "./retention-projection.js";

export {
  evaluateOverrides,
  validateOverrideRules,
  NO_OVERRIDES,
  type OverrideRule,
  type OverrideEffect,
  type OverrideVerdict,
  type RecordLabel,
} from "./override-rules.js";

export {
  createResidencyManager,
  residencyHooks,
  originalClassFor,
  ORIGINAL_CLASS_PREFIX,
  STARKEEP_LABEL_APP_ID,
  NO_CLOUD_LABEL_KEY,
  type ResidencyManager,
  type ResidencyManagerOptions,
} from "./residency-manager.js";
