export type {
  AppSyncableRowEntry,
  AppSyncableApplier,
  ScanCapableApplier,
  ScanSinceOptions,
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
} from "./types.js";

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
export {
  createHttpSyncHandler,
  type HttpSyncServerOptions,
} from "./transports/http-server.js";
export { SyncError, SyncConflictError } from "./errors.js";
