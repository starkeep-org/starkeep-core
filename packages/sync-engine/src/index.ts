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
  AppSyncableColumnInfo,
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
export { SHARED_DIGEST_SCOPE, parseAppSyncableTables } from "./types.js";
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
  type RecordConstraints,
  type LocalOverrides,
  type BlobCandidate,
  type ResidencyDecision,
  type ResidencyVerdict,
  type DecideResidencyInputs,
} from "./residency-policy.js";

export {
  createSqliteResidentSetIndex,
  type ReconcileReport,
  type ResidentArrival,
  type ResidentEntry,
  type ResidentSetIndex,
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
export { createSyncEngine, blobCandidateForRecord } from "./sync-engine.js";
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
  createResidencyManager,
  residencyHooks,
  KEPT_GROUP,
  STARKEEP_LABEL_APP_ID,
  NO_CLOUD_LABEL_KEY,
  type ResidencyManager,
  type ResidencyManagerOptions,
  type FreeUpSpaceRequest,
  type FreeUpSpaceReport,
  type FreeUpSpaceItem,
  type FreeUpSpaceRefusal,
} from "./residency-manager.js";
export {
  slotOccupant,
  tombstoneOf,
  admitIncomingStandIn,
  yieldSlotToIncoming,
} from "./stand-in-slots.js";
