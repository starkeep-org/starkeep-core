import type { DatabaseSync } from "node:sqlite";
import {
  createHttpSyncTransport,
  createSqliteChangeLog,
  createSyncEngine,
} from "../../packages/sync-engine/src/index.js";
import type {
  SyncEngine,
  SyncStateStore,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableApplier,
  ScanCapableApplier,
} from "../../packages/sync-engine/src/types.js";
import type {
  StarkeepId,
  DataRecord,
  AnyRecord,
  HLCClock,
} from "@starkeep/core";
import { SyncStatus } from "@starkeep/core";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { StarkeepSdk } from "../../packages/sdk/src/types.js";
import { HttpObjectStorageAdapter } from "./http-object-storage.js";
import { createPerAppSyncStateStore } from "./per-app-sync-state-store.js";

export type ConflictResolution =
  | { keep: "local" }
  | { keep: "server" }
  | { keep: "custom"; record: AnyRecord };

export interface AppRegistryEntry {
  readonly appId: string;
  readonly status: string;
}

export interface SyncSupervisorOptions {
  readonly sdk: StarkeepSdk;
  readonly databaseAdapter: DatabaseAdapter;
  readonly localObjectStorage: ObjectStorageAdapter;
  readonly localDb: DatabaseSync;
  readonly cloudUrl: string;
  readonly getAuthHeader: () => string | undefined;
  /**
   * Returns the current list of installed apps from the registry. The
   * supervisor calls it on startup and on `rescan()`.
   */
  readonly listInstalledApps: () => AppRegistryEntry[];
  readonly namespaceStore: AppSyncableNamespaceStore;
  readonly appApplier: AppSyncableApplier & ScanCapableApplier;
  readonly listAppSyncableFiles: (
    appId: string,
  ) => Promise<{ key: string }[]>;
  readonly underlyingSyncStateStore: SyncStateStore;
  readonly pullIntervalMs: number;
  readonly pushDebounceMs: number;
}

interface EngineEntry {
  readonly appId: string;
  readonly engine: SyncEngine;
  pullTimer: NodeJS.Timeout | null;
  pushTimer: NodeJS.Timeout | null;
  lastPullAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
  pullBackoffMs: number;
  unsubscribe: () => void;
}

export interface SyncSupervisorStatus {
  readonly enabled: boolean;
  readonly syncPaused: boolean;
  readonly cloudUrl: string;
  readonly perApp: Array<{
    appId: string;
    lastPullAt: string | null;
    lastPushAt: string | null;
    lastError: string | null;
    pullBackoffMs: number;
    conflictCount: number;
  }>;
  readonly conflictCount: number;
  readonly lastError: string | null;
  readonly lastPullAt: string | null;
  readonly lastPushAt: string | null;
  readonly pullBackoffMs: number;
}

export interface SyncSupervisor {
  start(): void;
  stop(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  fullSync(): Promise<{ pulled: number; pushed: number; rejected: number }>;
  schedulePushFor(appId: string): void;
  status(): SyncSupervisorStatus;
  conflicts(): Array<{ appId: string; conflict: ReturnType<SyncEngine["getConflicts"]>[number] }>;
  resolveConflict(
    recordId: StarkeepId,
    resolution: ConflictResolution,
  ): Promise<DataRecord | null>;
  /**
   * Re-read the app registry and reconcile: start engines for newly-active
   * apps, stop engines for apps no longer present. Called after install /
   * uninstall flows mutate the registry.
   */
  rescan(): void;
}

/**
 * Per-app namespace store: list() returns only this app's namespace (or
 * nothing if the app has no syncable namespace registered). `get()` honors
 * lookups for any appId because the applier may need to apply incoming rows
 * for the same app — but only `list()` drives which tables the engine
 * scans on push, and that's what we narrow.
 */
function narrowNamespaceStore(
  inner: AppSyncableNamespaceStore,
  appId: string,
): AppSyncableNamespaceStore {
  return {
    get(id: string): AppSyncableNamespace | null {
      return inner.get(id);
    },
    list(): AppSyncableNamespace[] {
      const ns = inner.get(appId);
      return ns ? [ns] : [];
    },
  };
}

export function createSyncSupervisor(
  options: SyncSupervisorOptions,
): SyncSupervisor {
  const {
    sdk,
    databaseAdapter,
    localObjectStorage,
    localDb,
    cloudUrl,
    getAuthHeader,
    listInstalledApps,
    namespaceStore,
    appApplier,
    listAppSyncableFiles,
    underlyingSyncStateStore,
    pullIntervalMs,
    pushDebounceMs,
  } = options;

  const engines = new Map<string, EngineEntry>();
  let paused = false;
  const cloudUrlBase = cloudUrl.replace(/\/+$/, "");

  function startEngineFor(appId: string): void {
    if (engines.has(appId)) return;

    const perAppBaseUrl = `${cloudUrlBase}/apps/${encodeURIComponent(appId)}`;

    const transport = createHttpSyncTransport({
      baseUrl: perAppBaseUrl,
      getAuthHeader,
    });

    const remoteStorage = new HttpObjectStorageAdapter({
      baseUrl: `${perAppBaseUrl}/files`,
      getAuthHeader,
    });

    // Each engine sees only its own app's pending writes — filter the
    // shared sync_change_log by recordSnapshot.originAppId.
    const changeLog = createSqliteChangeLog({
      db: localDb,
      originAppIdFilter: appId,
    });

    const syncState = createPerAppSyncStateStore(
      localDb,
      underlyingSyncStateStore,
      appId,
    );

    const narrowedNamespaces = narrowNamespaceStore(namespaceStore, appId);

    const engine = createSyncEngine({
      localDatabaseAdapter: databaseAdapter,
      localObjectStorage,
      remoteObjectStorage: remoteStorage,
      transport,
      clock: sdk.clock,
      changeLog,
      syncState,
      listAppSyncableFiles: () => listAppSyncableFiles(appId),
      appSyncableSource: {
        namespaces: narrowedNamespaces,
        applier: appApplier,
      },
    });

    // Republish engine events on the SDK's unified notifier so consumers
    // (sharedSpaceApi, SSE clients) see one stream.
    const unsubscribe = engine.changeNotifier.subscribe((event) => {
      sdk.changeNotifier.emit(event);
    });

    const entry: EngineEntry = {
      appId,
      engine,
      pullTimer: null,
      pushTimer: null,
      lastPullAt: null,
      lastPushAt: null,
      lastError: null,
      pullBackoffMs: pullIntervalMs,
      unsubscribe,
    };
    engines.set(appId, entry);
    schedulePullLoop(entry);
    console.log(`[sync] started loop for app=${appId} at ${perAppBaseUrl}`);
  }

  function stopEngineFor(appId: string): void {
    const entry = engines.get(appId);
    if (!entry) return;
    if (entry.pullTimer) clearTimeout(entry.pullTimer);
    if (entry.pushTimer) clearTimeout(entry.pushTimer);
    entry.unsubscribe();
    engines.delete(appId);
    console.log(`[sync] stopped loop for app=${appId}`);
  }

  function schedulePullLoop(entry: EngineEntry): void {
    if (paused) return;
    entry.pullTimer = setTimeout(() => runPullOnce(entry), entry.pullBackoffMs);
  }

  async function runPullOnce(entry: EngineEntry): Promise<void> {
    entry.pullTimer = null;
    try {
      await entry.engine.pull();
      entry.lastPullAt = new Date().toISOString();
      entry.lastError = null;
      entry.pullBackoffMs = pullIntervalMs;
    } catch (err) {
      entry.lastError = (err as Error).message;
      entry.pullBackoffMs = Math.min(entry.pullBackoffMs * 2, 5 * 60 * 1000);
      console.error(`[sync] pull failed for app=${entry.appId}:`, err);
    }
    if (!paused) schedulePullLoop(entry);
  }

  function schedulePushFor(appId: string): void {
    const entry = engines.get(appId);
    if (!entry) return;
    if (paused) return;
    if (entry.pushTimer) return;
    entry.pushTimer = setTimeout(async () => {
      entry.pushTimer = null;
      try {
        await entry.engine.push();
        entry.lastPushAt = new Date().toISOString();
        entry.lastError = null;
      } catch (err) {
        entry.lastError = (err as Error).message;
        console.error(`[sync] push failed for app=${entry.appId}:`, err);
      }
    }, pushDebounceMs);
  }

  // Listen to local writes and fan out a debounced push to every engine.
  // Each engine's change-log view is filtered by originAppId, so the
  // engine for app X only pushes records originated by X.
  sdk.changeNotifier.subscribe((event) => {
    if (event.eventType !== "local-change-recorded") return;
    if (paused) return;
    for (const entry of engines.values()) {
      schedulePushFor(entry.appId);
    }
  });

  function findConflictOwner(
    recordId: StarkeepId,
  ): { entry: EngineEntry; conflict: ReturnType<SyncEngine["getConflicts"]>[number] } | null {
    for (const entry of engines.values()) {
      const c = entry.engine.getConflicts().find((c) => c.recordId === recordId);
      if (c) return { entry, conflict: c };
    }
    return null;
  }

  async function resolveConflict(
    recordId: StarkeepId,
    resolution: ConflictResolution,
  ): Promise<DataRecord | null> {
    const found = findConflictOwner(recordId);
    if (!found) return null;
    const { entry, conflict } = found;
    const clock: HLCClock = sdk.clock;

    if (resolution.keep === "server") {
      if (!conflict.server) {
        await databaseAdapter.delete(recordId);
        entry.engine.clearConflict(recordId);
        return null;
      }
      await databaseAdapter.put({
        ...conflict.server,
        syncStatus: SyncStatus.Synced,
      });
      entry.engine.clearConflict(recordId);
      return databaseAdapter.get(recordId);
    }

    if (resolution.keep === "local") {
      const baseVersion = conflict.server?.version ?? null;
      const rebased: DataRecord = {
        ...(conflict.local as DataRecord),
        version: (baseVersion ?? 0) + 1,
        updatedAt: clock.now(),
        syncStatus: SyncStatus.PendingPush,
      };
      await databaseAdapter.put(rebased);
      entry.engine.clearConflict(recordId);
      await entry.engine.recordChange(
        conflict.server ? "update" : "create",
        rebased,
        { baseVersion },
      );
      return rebased;
    }

    // keep: "custom"
    await databaseAdapter.put({
      ...(resolution.record as DataRecord),
      syncStatus: SyncStatus.PendingPush,
    });
    entry.engine.clearConflict(recordId);
    await entry.engine.recordChange("update", resolution.record, {
      baseVersion: conflict.server?.version ?? null,
    });
    return resolution.record as DataRecord;
  }

  function rescan(): void {
    const desired = new Set(
      listInstalledApps()
        .filter((a) => a.status === "active")
        .map((a) => a.appId),
    );
    // Start new apps
    for (const appId of desired) {
      if (!engines.has(appId)) startEngineFor(appId);
    }
    // Stop apps no longer in the registry
    for (const appId of Array.from(engines.keys())) {
      if (!desired.has(appId)) stopEngineFor(appId);
    }
  }

  return {
    start() {
      rescan();
    },

    async stop() {
      for (const appId of Array.from(engines.keys())) {
        stopEngineFor(appId);
      }
    },

    pause() {
      paused = true;
      for (const entry of engines.values()) {
        if (entry.pullTimer) {
          clearTimeout(entry.pullTimer);
          entry.pullTimer = null;
        }
        if (entry.pushTimer) {
          clearTimeout(entry.pushTimer);
          entry.pushTimer = null;
        }
      }
    },

    async resume() {
      paused = false;
      // Kick off an immediate full sync per engine, then resume pull loops.
      await Promise.all(
        Array.from(engines.values()).map(async (entry) => {
          try {
            await entry.engine.fullSync();
            entry.lastPullAt = new Date().toISOString();
            entry.lastPushAt = new Date().toISOString();
            entry.lastError = null;
            entry.pullBackoffMs = pullIntervalMs;
          } catch (err) {
            entry.lastError = (err as Error).message;
            console.error(`[sync] resume fullSync failed for app=${entry.appId}:`, err);
          }
          schedulePullLoop(entry);
        }),
      );
    },

    async fullSync() {
      let pulled = 0;
      let pushed = 0;
      let rejected = 0;
      for (const entry of engines.values()) {
        try {
          const r = await entry.engine.fullSync();
          pulled += r.pulled;
          pushed += r.pushed;
          rejected += r.rejected;
          entry.lastPullAt = new Date().toISOString();
          entry.lastPushAt = new Date().toISOString();
          entry.lastError = null;
        } catch (err) {
          entry.lastError = (err as Error).message;
          console.error(`[sync] fullSync failed for app=${entry.appId}:`, err);
        }
      }
      return { pulled, pushed, rejected };
    },

    schedulePushFor,

    status() {
      const perApp = Array.from(engines.values()).map((e) => ({
        appId: e.appId,
        lastPullAt: e.lastPullAt,
        lastPushAt: e.lastPushAt,
        lastError: e.lastError,
        pullBackoffMs: e.pullBackoffMs,
        conflictCount: e.engine.getConflicts().length,
      }));
      // Aggregate fields for legacy /sync/status shape.
      const lastPullAt = perApp.reduce<string | null>(
        (acc, e) => (e.lastPullAt && (!acc || e.lastPullAt > acc) ? e.lastPullAt : acc),
        null,
      );
      const lastPushAt = perApp.reduce<string | null>(
        (acc, e) => (e.lastPushAt && (!acc || e.lastPushAt > acc) ? e.lastPushAt : acc),
        null,
      );
      const lastError = perApp.find((e) => e.lastError !== null)?.lastError ?? null;
      const pullBackoffMs = perApp.reduce<number>(
        (acc, e) => Math.max(acc, e.pullBackoffMs),
        pullIntervalMs,
      );
      return {
        enabled: engines.size > 0,
        syncPaused: paused,
        cloudUrl: cloudUrlBase,
        perApp,
        conflictCount: perApp.reduce((acc, e) => acc + e.conflictCount, 0),
        lastError,
        lastPullAt,
        lastPushAt,
        pullBackoffMs,
      };
    },

    conflicts() {
      const out: Array<{
        appId: string;
        conflict: ReturnType<SyncEngine["getConflicts"]>[number];
      }> = [];
      for (const entry of engines.values()) {
        for (const c of entry.engine.getConflicts()) {
          out.push({ appId: entry.appId, conflict: c });
        }
      }
      return out;
    },

    resolveConflict,

    rescan,
  };
}
