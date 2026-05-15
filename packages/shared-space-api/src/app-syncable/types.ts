// Re-export the engine-agnostic app-syncable interfaces from sync-engine so
// callers can import them from @starkeep/shared-space-api without knowing the
// internal layering.
export type {
  AppSyncableTableInfo,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  AppSyncableRowLogEntry,
} from "@starkeep/sync-engine";
