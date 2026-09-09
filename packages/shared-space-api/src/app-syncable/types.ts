// Re-export the engine-agnostic app-syncable interfaces from sync-engine so
// callers can import them from @starkeep/shared-space-api without knowing the
// internal layering.
export type {
  AppSyncableColumnInfo,
  AppSyncableTableInfo,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  ScanCapableApplier,
  ScanSincePage,
  StreamTruncation,
  AppSyncableRowEntry,
  FileRecordRow,
} from "@starkeep/sync-engine";
