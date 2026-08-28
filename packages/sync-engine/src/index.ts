export type {
  AppSyncableRowEntry,
  AppSyncableApplier,
  ScanCapableApplier,
  ScanSincePage,
  SyncTransport,
  FileSyncManifest,
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
  SyncRecordItem,
  SyncExchangeResponse,
  ExchangeResult,
  ExchangeOptions,
  SyncOptions,
  SyncResult,
  VerifyResult,
  ResidencyDecider,
  ResidencyHooks,
  AcquireResult,
} from "./types.js";
export { SHARED_DIGEST_SCOPE } from "./types.js";
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
  resolveSizeClass,
  parseSizeClass,
  isPlatformClass,
  retentionRowFor,
  hasRowFor,
  namespaceRetentionFor,
  budgetLineFor,
  budgetBytesFor,
  budgetLinesOf,
  compareEvictionRank,
  PLATFORM_NAMESPACE,
  FALLBACK_RUNG,
  type SizeClassRetention,
  type NamespaceRetention,
  type NodeRetentionPolicy,
  type BudgetLine,
  type EvictionRank,
  type ResolvedSizeClass,
  type RecordConstraints,
  type LocalOverrides,
  type BlobCandidate,
  type ResidencyDecision,
  type ResidencyTrigger,
  type ResidencyVerdict,
  type LineUsageLookup,
  type DisplacementLookup,
  type DecideResidencyInputs,
} from "./residency-policy.js";

export {
  createSqliteResidentSetIndex,
  type ReconcileReport,
  type ResidentArrival,
  type ResidentEntry,
  type ResidentSetIndex,
  type EvictionCandidateQuery,
  type DeferredCandidateQuery,
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
  evictLine,
  previewBudgetReduction,
  shedLoad,
  SHED_ORDER,
  type RetentionReason,
  type EvictionOutcome,
  type EvictionRequest,
  type ReductionPreview,
  type ShedStep,
} from "./eviction.js";

export {
  scanForAcquirable,
  SCAN_PAGE_ROWS,
  type AcquisitionScanRequest,
  type AcquisitionScanResult,
  type AcquisitionCandidateSink,
  type AcquisitionConsideration,
} from "./acquisition-scan.js";

export {
  runAcquisition,
  ACQUISITION_PAGE_ROWS,
  type AcquisitionRequest,
  type AcquisitionOutcome,
} from "./acquisition.js";

export { createSqliteSyncStateStore } from "./sync-state-sqlite.js";
export { createChangeNotifier } from "./change-notifier.js";
export { advanceWatermark, mergeWatermarks, watermarkFor, selectUnseen } from "./watermarks.js";
export { createFileSyncEngine } from "./file-sync-engine.js";
export { createSyncEngine } from "./sync-engine.js";
export {
  residencyOf,
  type RecordResidency,
  type RecordResidencyState,
} from "./residency.js";
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
  sanitizeExchangeRequest,
  sanitizeWatermarkMap,
  InvalidExchangeRequest,
  DEFAULT_RESPONDER_MAX_ITEMS,
  DEFAULT_RESPONDER_MAX_BYTES,
  type SanitizeExchangeRequestOptions,
} from "./exchange-request.js";

export {
  projectPolicy,
  formatBytes,
  type SizeClassCensus,
  type RowProjection,
  type NamespaceProjection,
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
  pickLadderLabel,
  UNCLASSIFIED_RUNG,
  type LadderLabel,
  ORIGINAL_CLASS_PREFIX,
  STARKEEP_LABEL_APP_ID,
  NO_CLOUD_LABEL_KEY,
  type ResidencyManager,
  type ResidencyManagerOptions,
} from "./residency-manager.js";
