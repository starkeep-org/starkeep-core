import type { DatabaseSync } from "node:sqlite";
import {
  createHttpSyncTransport,
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
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { StarkeepSdk } from "../../packages/sdk/src/types.js";
import { HttpObjectStorageAdapter } from "./http-object-storage.js";
import { createPerAppSyncStateStore } from "./per-app-sync-state-store.js";
import { LOCAL_WATCHER_APP_ID } from "../../packages/admin-installer/src/iam.js";
import { signRequest } from "../../packages/app-client/src/sign.js";
import { appRegistryRow } from "../../packages/admin-installer/src/local/registry.js";

/**
 * The reserved app id of the always-on Starkeep Drive channel — the single
 * channel that carries all shared records. Mirrors
 * USER_DATA_OWNER_APP_ID in packages/admin-installer/src/iam.ts.
 */
export const DRIVE_APP_ID = "starkeep-drive";

/**
 * App ids that have no per-app cloud channel and therefore must never get a
 * per-app sync engine. The always-on Drive engine carries their (shared-data
 * only) writes; spinning a per-app channel for them would just produce a
 * permanent 403 loop because the cloud-side per-app IAM role doesn't exist.
 */
const NO_PER_APP_CHANNEL_APP_IDS: ReadonlySet<string> = new Set([
  DRIVE_APP_ID,
  LOCAL_WATCHER_APP_ID,
]);

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
  /**
   * Returns the current list of installed apps from the registry. The
   * supervisor calls it on startup and on `rescan()`.
   */
  readonly listInstalledApps: () => AppRegistryEntry[];
  readonly namespaceStore: AppSyncableNamespaceStore;
  readonly appApplier: AppSyncableApplier & ScanCapableApplier;
  readonly underlyingSyncStateStore: SyncStateStore;
  /** Idle interval between exchange ticks. A local write nudges an early tick. */
  readonly exchangeIntervalMs: number;
  /** Debounce window for local-change-recorded → exchange. */
  readonly nudgeDebounceMs: number;
  /**
   * Max items per exchange round, passed through to every engine
   * (`SyncEngineOptions.pageLimit`). Engine default (1000) when omitted.
   */
  readonly pageLimit?: number;
}

interface EngineEntry {
  readonly appId: string;
  readonly engine: SyncEngine;
  /** Idle tick timer — fires every exchangeIntervalMs unless nudged earlier. */
  tickTimer: NodeJS.Timeout | null;
  /** Local-write nudge timer — debounces local-change-recorded into one exchange. */
  nudgeTimer: NodeJS.Timeout | null;
  /** Detaches the engine→SDK change-event forwarding on engine teardown. */
  unsubscribeForwarding: () => void;
  lastExchangeAt: string | null;
  lastError: string | null;
  backoffMs: number;
}

export interface SyncSupervisorStatus {
  readonly enabled: boolean;
  readonly syncPaused: boolean;
  readonly cloudUrl: string;
  readonly perApp: Array<{
    appId: string;
    lastExchangeAt: string | null;
    lastError: string | null;
    backoffMs: number;
  }>;
  /** Aggregated across all engines — null if no exchange has succeeded yet. */
  readonly lastExchangeAt: string | null;
  /** First non-null per-app error, or null if all healthy. */
  readonly lastError: string | null;
  readonly backoffMs: number;
}

export interface SyncSupervisor {
  start(): void;
  stop(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  /** Trigger an immediate exchange across every engine. */
  exchangeAll(): Promise<{ applied: number; shipped: number }>;
  /**
   * Reset per-app backoff and trigger an immediate exchange across every
   * engine. Use after a recoverable external state change (most notably an
   * id-token refresh) so engines sitting in long backoff after auth failures
   * resume their normal cadence right away instead of waiting up to 5 min.
   */
  kick(): void;
  /** Nudge a specific app's exchange to fire on the debounce window. */
  schedulePushFor(appId: string): void;
  status(): SyncSupervisorStatus;
  /**
   * Re-read the app registry and reconcile: start engines for newly-active
   * apps, stop engines for apps no longer present.
   */
  rescan(): void;
}

/**
 * Per-app namespace store: list() returns only this app's namespace (or
 * nothing if the app has no syncable namespace registered). `get()` honors
 * lookups for any appId because the applier may need to apply incoming rows
 * for the same app — but only `list()` drives which tables the engine scans.
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
    listInstalledApps,
    namespaceStore,
    appApplier,
    underlyingSyncStateStore,
    exchangeIntervalMs,
    nudgeDebounceMs,
    pageLimit,
  } = options;

  const engines = new Map<string, EngineEntry>();
  let paused = false;
  const cloudUrlBase = cloudUrl.replace(/\/+$/, "");

  // Per-engine HMAC signer. The cloud verifier requires every /apps/{appId}/*
  // request to carry an X-Starkeep-App-Sig HMAC over `${appId}:` ++ body bytes
  // (see packages/app-client/src/sign.ts and the verifier in
  // cloud-data-server/src/api-handler.ts). The per-app hmac secret is the same
  // value the installer wrote into both the local registry and the SSM
  // SecureString at cloud install, so both sides agree.
  //
  // Hard-fail if the secret is missing. The previous warn-and-return-undefined
  // sent unsigned traffic to the broker, which would 401 — but the supervisor
  // would keep retrying and the warning was easy to miss. Refusing to start
  // the engine is louder and matches the install invariant: every registered
  // app has an hmac_secret.
  function makeSignerFor(
    appId: string,
  ): (method: string, path: string, body: string) => Record<string, string> {
    const row = appRegistryRow(localDb, appId);
    const hmacSecret = row?.hmacSecret;
    if (!hmacSecret) {
      throw new Error(
        `[sync] no hmac_secret in local registry for app=${appId}. ` +
        `Re-run the local install for this app; the supervisor will not sign ` +
        `outbound requests without it.`,
      );
    }
    return (method: string, path: string, body: string) =>
      signRequest({ appId, hmacSecret, method, path, body });
  }

  function makeEngineEntry(
    appId: string,
    engine: SyncEngine,
    baseUrl: string,
  ): void {
    // Each engine emits pull-side events (local-data-synced) on its own
    // internal notifier; forward them onto the SDK's unified notifier so the
    // /events SSE fan-out kicks on sync-applied remote changes too. The
    // supervisor's own nudge subscription filters on local-change-recorded,
    // so forwarding cannot feed back into an exchange loop.
    const unsubscribeForwarding = engine.changeNotifier.subscribe((event) =>
      sdk.changeNotifier.emit(event),
    );
    const entry: EngineEntry = {
      appId,
      engine,
      tickTimer: null,
      nudgeTimer: null,
      unsubscribeForwarding,
      lastExchangeAt: null,
      lastError: null,
      backoffMs: exchangeIntervalMs,
    };
    engines.set(appId, entry);
    scheduleTick(entry);
    // Drain any pending local writes that accumulated before this engine
    // existed (server restart, install race).
    scheduleNudge(appId);
    console.log(`[sync] started loop for app=${appId} at ${baseUrl}`);
  }

  /**
   * The always-on Drive channel. It ships and applies *all* shared records and
   * nothing app-specific (no appSyncableSource, syncSharedRecords true). It
   * runs independently of the installed-app set — started in start() and never
   * torn down by rescan() — so shared-data sync is identical before and after
   * any app's cloud install.
   */
  function startDriveEngine(): void {
    if (engines.has(DRIVE_APP_ID)) return;
    const baseUrl = `${cloudUrlBase}/apps/${encodeURIComponent(DRIVE_APP_ID)}`;
    const driveSigner = makeSignerFor(DRIVE_APP_ID);
    const transport = createHttpSyncTransport({ baseUrl, signRequest: driveSigner });
    const remoteStorage = new HttpObjectStorageAdapter({
      baseUrl: `${baseUrl}/files`,
      signRequest: driveSigner,
    });
    const syncState = createPerAppSyncStateStore(
      localDb,
      underlyingSyncStateStore,
      DRIVE_APP_ID,
    );
    const engine = createSyncEngine({
      localDatabaseAdapter: databaseAdapter,
      localObjectStorage,
      remoteObjectStorage: remoteStorage,
      transport,
      clock: sdk.clock,
      syncState,
      syncSharedRecords: true,
      pageLimit,
      // No appSyncableSource: the Drive channel never carries app-specific rows.
    });
    makeEngineEntry(DRIVE_APP_ID, engine, baseUrl);
  }

  function startEngineFor(appId: string): void {
    if (engines.has(appId)) return;

    const perAppBaseUrl = `${cloudUrlBase}/apps/${encodeURIComponent(appId)}`;
    const appSigner = makeSignerFor(appId);

    const transport = createHttpSyncTransport({
      baseUrl: perAppBaseUrl,
      signRequest: appSigner,
    });

    const remoteStorage = new HttpObjectStorageAdapter({
      baseUrl: `${perAppBaseUrl}/files`,
      signRequest: appSigner,
    });

    const syncState = createPerAppSyncStateStore(
      localDb,
      underlyingSyncStateStore,
      appId,
    );

    const narrowedNamespaces = narrowNamespaceStore(namespaceStore, appId);

    // Per-app channels carry only this app's app-specific rows. Shared records
    // sync exclusively via the Drive channel, so syncSharedRecords is false
    // here.
    const engine = createSyncEngine({
      localDatabaseAdapter: databaseAdapter,
      localObjectStorage,
      remoteObjectStorage: remoteStorage,
      transport,
      clock: sdk.clock,
      syncState,
      syncSharedRecords: false,
      pageLimit,
      appSyncableSource: {
        namespaces: narrowedNamespaces,
        applier: appApplier,
      },
    });

    makeEngineEntry(appId, engine, perAppBaseUrl);
  }

  function stopEngineFor(appId: string): void {
    const entry = engines.get(appId);
    if (!entry) return;
    if (entry.tickTimer) clearTimeout(entry.tickTimer);
    if (entry.nudgeTimer) clearTimeout(entry.nudgeTimer);
    entry.unsubscribeForwarding();
    engines.delete(appId);
    console.log(`[sync] stopped loop for app=${appId}`);
  }

  function scheduleTick(entry: EngineEntry): void {
    if (paused) return;
    entry.tickTimer = setTimeout(() => runExchangeOnce(entry), entry.backoffMs);
  }

  async function runExchangeOnce(entry: EngineEntry): Promise<void> {
    entry.tickTimer = null;
    try {
      await entry.engine.exchange();
      entry.lastExchangeAt = new Date().toISOString();
      entry.lastError = null;
      entry.backoffMs = exchangeIntervalMs;
    } catch (err) {
      entry.lastError = (err as Error).message;
      entry.backoffMs = Math.min(entry.backoffMs * 2, 5 * 60 * 1000);
      console.error(`[sync] exchange failed for app=${entry.appId}:`, err);
    }
    if (!paused) scheduleTick(entry);
  }

  function scheduleNudge(appId: string): void {
    const entry = engines.get(appId);
    if (!entry) return;
    if (paused) return;
    if (entry.nudgeTimer) return;
    entry.nudgeTimer = setTimeout(async () => {
      entry.nudgeTimer = null;
      if (entry.tickTimer) {
        clearTimeout(entry.tickTimer);
        entry.tickTimer = null;
      }
      await runExchangeOnce(entry);
    }, nudgeDebounceMs);
  }

  // Local-write routing: nudge only the engine that owns the affected data
  // plane. Shape-A convention:
  //   - `local-change-recorded` with no originAppId → shared-record write,
  //     owned by the always-on Drive channel.
  //   - `local-change-recorded` with originAppId set → app-specific write,
  //     owned by that app's per-app engine (no-op if the app has no engine,
  //     e.g. Drive / watcher whose writes ride the Drive channel).
  sdk.changeNotifier.subscribe((event) => {
    if (event.eventType !== "local-change-recorded") return;
    if (paused) return;
    const targetAppId = event.originAppId ?? DRIVE_APP_ID;
    scheduleNudge(targetAppId);
  });

  function rescan(): void {
    // Exclude apps that have no per-app cloud channel (Drive and the built-in
    // local-watcher): their writes ride the always-on Drive engine, and
    // spinning a per-app engine for them would just 403 forever.
    const desired = new Set(
      listInstalledApps()
        .filter((a) => a.status === "active")
        .map((a) => a.appId)
        .filter((appId) => !NO_PER_APP_CHANNEL_APP_IDS.has(appId)),
    );
    for (const appId of desired) {
      if (!engines.has(appId)) startEngineFor(appId);
    }
    for (const appId of Array.from(engines.keys())) {
      if (NO_PER_APP_CHANNEL_APP_IDS.has(appId)) continue;
      if (!desired.has(appId)) stopEngineFor(appId);
    }
  }

  return {
    start() {
      // Always-on Drive channel first, then reconcile per-app channels.
      startDriveEngine();
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
        if (entry.tickTimer) {
          clearTimeout(entry.tickTimer);
          entry.tickTimer = null;
        }
        if (entry.nudgeTimer) {
          clearTimeout(entry.nudgeTimer);
          entry.nudgeTimer = null;
        }
      }
    },

    async resume() {
      paused = false;
      await Promise.all(
        Array.from(engines.values()).map(async (entry) => {
          try {
            await entry.engine.exchange();
            entry.lastExchangeAt = new Date().toISOString();
            entry.lastError = null;
            entry.backoffMs = exchangeIntervalMs;
          } catch (err) {
            entry.lastError = (err as Error).message;
            console.error(`[sync] resume exchange failed for app=${entry.appId}:`, err);
          }
          scheduleTick(entry);
        }),
      );
    },

    async exchangeAll() {
      let applied = 0;
      let shipped = 0;
      for (const entry of engines.values()) {
        try {
          const r = await entry.engine.exchange();
          applied += r.applied;
          shipped += r.shipped;
          entry.lastExchangeAt = new Date().toISOString();
          entry.lastError = null;
        } catch (err) {
          entry.lastError = (err as Error).message;
          console.error(`[sync] exchangeAll failed for app=${entry.appId}:`, err);
        }
      }
      return { applied, shipped };
    },

    kick() {
      if (paused) return;
      for (const entry of engines.values()) {
        if (entry.tickTimer) {
          clearTimeout(entry.tickTimer);
          entry.tickTimer = null;
        }
        entry.backoffMs = exchangeIntervalMs;
        // Fire-and-forget; runExchangeOnce reschedules the next tick itself.
        void runExchangeOnce(entry);
      }
    },

    schedulePushFor: scheduleNudge,

    status() {
      const perApp = Array.from(engines.values()).map((e) => ({
        appId: e.appId,
        lastExchangeAt: e.lastExchangeAt,
        lastError: e.lastError,
        backoffMs: e.backoffMs,
      }));
      const lastExchangeAt = perApp.reduce<string | null>(
        (acc, e) => (e.lastExchangeAt && (!acc || e.lastExchangeAt > acc) ? e.lastExchangeAt : acc),
        null,
      );
      const lastError = perApp.find((e) => e.lastError !== null)?.lastError ?? null;
      const backoffMs = perApp.reduce<number>(
        (acc, e) => Math.max(acc, e.backoffMs),
        exchangeIntervalMs,
      );
      return {
        enabled: engines.size > 0,
        syncPaused: paused,
        cloudUrl: cloudUrlBase,
        perApp,
        lastExchangeAt,
        lastError,
        backoffMs,
      };
    },

    rescan,
  };
}
