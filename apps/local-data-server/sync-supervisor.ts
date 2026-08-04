import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  HttpObjectStorageAdapter,
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
  ResidencyHooks,
  VerifyResult,
} from "../../packages/sync-engine/src/types.js";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { StarkeepSdk } from "../../packages/sdk/src/types.js";
import { createPerAppSyncStateStore } from "./per-app-sync-state-store.js";
import { createEngineRunner, type EngineRunner } from "./engine-runner.js";
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
  readonly localDb: RawDatabase;
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
   * Byte budget for one exchange round, passed through to every engine
   * (`SyncEngineOptions.maxBytes`). Engine default (25 MB) when omitted.
   *
   * The budget that binds on the Drive channel, which carries files. Per-app
   * channels mostly carry small rows and are bounded by {@link maxItems}
   * instead — which is why one pair of numbers suits every engine here and no
   * per-app knob is needed.
   */
  readonly maxBytes?: number;
  /**
   * Item cap for one exchange round, passed through to every engine
   * (`SyncEngineOptions.maxItems`). Engine default (1000) when omitted.
   */
  readonly maxItems?: number;
  /**
   * Residency decision + byte accounting, consulted before every inbound blob
   * pull on every channel.
   *
   * Handed to both the Drive engine and each per-app engine, because a budget
   * that only bound one of them wouldn't bind: app-syncable blobs and shared
   * record blobs land on the same disk.
   */
  readonly residency?: ResidencyHooks;
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
  /**
   * Serializes everything that touches this engine — ticks, nudges,
   * `/sync/now`, `/sync/verify`, `resume()`. See `engine-runner.ts` for why an
   * engine cannot have two of them at once.
   */
  readonly runner: EngineRunner;
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
  /**
   * Drive every engine now, bounded so an HTTP handler cannot block on a whole
   * backlog.
   *
   * `complete` is false when rounds remain — call again to continue. That is
   * deliberately the caller's decision: a first sync of a real library is
   * hundreds of rounds and hours of transfer, and a request that runs until it
   * finishes is a request that times out. Honours pause, so `/sync/pause`
   * stops one already in flight.
   */
  exchangeAll(): Promise<{ applied: number; shipped: number; complete: boolean }>;
  /**
   * Compare row counts with the cloud on every channel and arm repairs.
   *
   * Occasional by nature — a grouped scan on both sides — so it is a request,
   * not a timer. It is the only thing that can see a row lost from the middle
   * of a range, in either direction; without a caller the digest machinery is
   * unreachable on this node.
   */
  verifyAll(): Promise<
    Array<{ appId: string; result: VerifyResult | null; error: string | null }>
  >;
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

/**
 * Rounds one `/sync/now` will run per engine before handing control back.
 *
 * Enough to make visible progress on a backlog, small enough that the request
 * returns. `complete: false` tells the caller to ask again.
 */
const SYNC_NOW_MAX_ROUNDS = 50;

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
    maxBytes,
    maxItems,
    residency,
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
      runner: createEngineRunner({ cancelled: () => paused }),
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
      maxBytes,
      maxItems,
      ...(residency ? { residency } : {}),
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
      maxBytes,
      maxItems,
      ...(residency ? { residency } : {}),
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

  /**
   * The one abort signal every drain reads. `paused` is checked on each access
   * rather than captured, so `/sync/pause` stops a loop already running.
   */
  const syncSignal = {
    get aborted() {
      return paused;
    },
  };

  /**
   * Exclusive use of one engine for the duration of `body`.
   *
   * A caller that has to wait genuinely does have to wait: the work it asked
   * for is already happening, and its answer should describe the state after
   * that work rather than race it.
   */
  function withEngine<T>(entry: EngineEntry, body: () => Promise<T>): Promise<T> {
    return entry.runner.run(body);
  }

  async function driveDrain(entry: EngineEntry): Promise<void> {
    try {
      // sync(), not one exchange(): a round is bounded by the byte budget, so a
      // backlog needs many of them and running one per timer tick would make a
      // large first sync take hours of wall clock doing nothing in between.
      // The loop stops as soon as both directions are drained, which in steady
      // state is after the first (pull-only) round.
      await entry.engine.sync({ signal: syncSignal });
      entry.lastExchangeAt = new Date().toISOString();
      entry.lastError = null;
      entry.backoffMs = exchangeIntervalMs;
    } catch (err) {
      entry.lastError = (err as Error).message;
      entry.backoffMs = Math.min(entry.backoffMs * 2, 5 * 60 * 1000);
      console.error(`[sync] exchange failed for app=${entry.appId}:`, err);
    }
  }

  async function runExchangeOnce(entry: EngineEntry): Promise<void> {
    entry.tickTimer = null;
    // Folds into a drain already running rather than starting a second one.
    // Only the caller that owned the drain reschedules the idle tick — a
    // folded-in caller returns immediately, and restarting the timer from there
    // would arm it while the drain is still going.
    const owned = await entry.runner.drain(() => driveDrain(entry));
    if (owned && !paused) scheduleTick(entry);
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
          await withEngine(entry, async () => {
            try {
              await entry.engine.sync({ signal: syncSignal });
              entry.lastExchangeAt = new Date().toISOString();
              entry.lastError = null;
              entry.backoffMs = exchangeIntervalMs;
            } catch (err) {
              entry.lastError = (err as Error).message;
              console.error(`[sync] resume exchange failed for app=${entry.appId}:`, err);
            }
          });
          scheduleTick(entry);
        }),
      );
    },

    async exchangeAll() {
      let applied = 0;
      let shipped = 0;
      let complete = true;
      for (const entry of engines.values()) {
        try {
          // Bounded, and cancellable by /sync/pause. A round is deliberately
          // small, so "sync everything" over a real backlog is hundreds of
          // rounds and hours of transfer — running that inside a request would
          // hold the connection open for the duration and ignore a pause. The
          // caller polls by asking again while `complete` is false.
          const r = await withEngine(entry, () =>
            entry.engine.sync({
              maxRounds: SYNC_NOW_MAX_ROUNDS,
              signal: syncSignal,
            }),
          );
          applied += r.applied;
          shipped += r.shipped;
          if (!r.complete) complete = false;
          if (r.stalled) {
            // Not an error — the watermarks are intact and the next attempt
            // resumes — but it is the difference between "done" and "wedged",
            // and silence here is how a stuck transfer looks like success.
            console.warn(
              `[sync] exchangeAll stalled for app=${entry.appId}: a round made no progress with work outstanding`,
            );
          }
          entry.lastExchangeAt = new Date().toISOString();
          entry.lastError = null;
        } catch (err) {
          entry.lastError = (err as Error).message;
          complete = false;
          console.error(`[sync] exchangeAll failed for app=${entry.appId}:`, err);
        }
      }
      return { applied, shipped, complete };
    },

    /**
     * Run the integrity check on every channel — on request only.
     *
     * There is deliberately no timer behind this, and the absence is a decision
     * rather than an omission. `verify()` is a `GROUP BY` over each side's whole
     * index plus a round trip, on both ends; it answers a question whose answer
     * only changes when something has already gone wrong, and running it on a
     * schedule would spend that on every node, forever, to find nothing.
     *
     * It is also the only thing that can see a row lost from the *middle* of an
     * author's range — the coverage watermark cannot — so "on request only"
     * means a loss sits undetected until a person presses the button. That is
     * the trade, stated so the next reader can take the other side of it: the
     * check is now safe to schedule (it reports a backlog as pending rather
     * than as loss, so a node mid-first-sync no longer alarms), and wiring it to
     * something occasional — after an idle drain completes, say, or daily —
     * needs no change here beyond calling this.
     */
    async verifyAll() {
      const out: Array<{
        appId: string;
        result: VerifyResult | null;
        error: string | null;
      }> = [];
      for (const entry of engines.values()) {
        try {
          // Under the lock: verify() writes repair and inbound floors, and a
          // round running concurrently would overwrite them from a stale read.
          const result = await withEngine(entry, () => entry.engine.verify());
          out.push({ appId: entry.appId, result, error: null });
        } catch (err) {
          out.push({ appId: entry.appId, result: null, error: (err as Error).message });
          console.error(`[sync] verify failed for app=${entry.appId}:`, err);
        }
      }
      return out;
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
