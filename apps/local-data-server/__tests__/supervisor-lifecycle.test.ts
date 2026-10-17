/**
 * The supervisor's two lifecycle promises, asserted directly.
 *
 * Both were failing quietly in ways the `/sync/*` e2e cannot see, because both
 * are about what happens to channels *other* than the one being observed.
 *
 *   - `stop()` cleared the timers and called it done. A tick's drain is a whole
 *     `sync()` with no `maxRounds`, so a drain in progress kept issuing requests
 *     and kept writing `sync_state` after the supervisor was nominally down —
 *     plausibly the leaking test process filed in `71a97ef`.
 *   - Every request carries this machine's device signature, and a machine
 *     with no key starts no engine at all rather than a loop of refusals.
 *
 * Assembled in-process rather than through a server subprocess: both cases are
 * about the supervisor's own control flow, and a subprocess would only let us
 * observe them through a status endpoint that reports the same thing either way.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { createHLCClock, deviceSigner, signedMessage, type DeviceSigner } from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
  type RawDatabase,
} from "@starkeep/storage-adapter";
import { createChangeNotifier } from "../../../packages/sync-engine/src/change-notifier.js";
import {
  createSyncSupervisor,
  DRIVE_APP_ID,
  type AppRegistryEntry,
  type SyncSupervisor,
} from "../sync-supervisor.js";
import type {
  AppSyncableApplier,
  AppSyncableNamespaceStore,
  ScanCapableApplier,
  SyncStateStore,
  Watermarks,
} from "../../../packages/sync-engine/src/types.js";
import type { StarkeepSdk } from "../../../packages/sdk/src/types.js";

/** Just enough registry and sync state for an engine to be built. */
function registryDb(rows: Array<{ appId: string }>): RawDatabase {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE shared_app_registry (
      app_id TEXT PRIMARY KEY, name TEXT, version TEXT, tier TEXT,
      manifest TEXT, status TEXT, hmac_secret TEXT,
      installed_at TEXT, updated_at TEXT
    )`);
  // The per-app sync-state store prepares its statements against this at
  // construction, so an engine cannot even be built without it.
  db.exec(`
    CREATE TABLE sync_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`);
  for (const row of rows) {
    db.prepare(
      `INSERT INTO shared_app_registry
         (app_id, name, version, tier, manifest, status, hmac_secret, installed_at, updated_at)
       VALUES (?, ?, '1.0.0', 'community', '{}', 'active', ?, '2026-08-04', '2026-08-04')`,
    ).run(row.appId, row.appId, null);
  }
  return db as unknown as RawDatabase;
}

const emptyNamespaces: AppSyncableNamespaceStore = { get: () => null, list: () => [] };

const noopApplier = {
  async apply() {},
  async scanSince() {
    return { rows: [], hasMore: false, truncated: {} };
  },
  async getNodeWatermarks() {
    return {};
  },
  async bucketDigest() {
    return [];
  },
} as unknown as AppSyncableApplier & ScanCapableApplier;

function memorySyncState(): SyncStateStore {
  const maps: Record<string, Watermarks> = { own: {}, peer: {}, repair: {}, inbound: {} };
  return {
    async getWatermarks() {
      return maps["own"]!;
    },
    async setWatermarks(w) {
      maps["own"] = w;
    },
    async getPeerWatermarks() {
      return maps["peer"]!;
    },
    async setPeerWatermarks(w) {
      maps["peer"] = w;
    },
    async getRepairFloors() {
      return maps["repair"]!;
    },
    async setRepairFloors(w) {
      maps["repair"] = w;
    },
    async getInboundFloors() {
      return maps["inbound"]!;
    },
    async setInboundFloors(w) {
      maps["inbound"] = w;
    },
    async getByteWatermarks() {
      return maps["bytes"] ?? null;
    },
    async setByteWatermarks(w) {
      maps["bytes"] = w;
    },
    async getPeerByteWatermarks() {
      return maps["peerBytes"] ?? null;
    },
    async setPeerByteWatermarks(w) {
      maps["peerBytes"] = w;
    },
    async getHlcClockState() {
      return null;
    },
    async setHlcClockState() {},
  };
}

let supervisor: SyncSupervisor | null = null;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = null;
});

async function build(options: {
  readonly apps: Array<{ appId: string }>;
  readonly exchangeIntervalMs?: number;
  readonly cloudUrl?: string;
  /**
   * What the registry reports as installed, if it has to change during a test.
   * Defaults to `apps` — the registry row itself stays put, because an
   * uninstall the supervisor is meant to notice is a change in what is
   * *listed*, not a row disappearing out from under a signer.
   */
  readonly installed?: () => Array<{ appId: string }>;
  /** Defaults to a fresh key; null is a machine nobody has connected. */
  readonly signer?: DeviceSigner | null;
}) {
  const databaseAdapter = new MockDatabaseAdapter();
  const localObjectStorage = new MockObjectStorageAdapter();
  await databaseAdapter.init();
  await localObjectStorage.init();
  const localDb = registryDb([
    { appId: DRIVE_APP_ID },
    ...options.apps,
  ]);
  const listInstalledApps = (): AppRegistryEntry[] =>
    (options.installed ? options.installed() : options.apps).map((a) => ({
      appId: a.appId,
      status: "active",
    }));

  const sdk = {
    clock: createHLCClock({ nodeId: "L" }),
    changeNotifier: createChangeNotifier(),
  } as unknown as StarkeepSdk;

  return createSyncSupervisor({
    sdk,
    databaseAdapter,
    localObjectStorage,
    localDb,
    // Nothing listens here. Every exchange fails, which is exactly the steady
    // state these cases care about — the question is which engines exist and
    // whether they are still running, not whether they succeed.
    cloudUrl: options.cloudUrl ?? "http://127.0.0.1:1",
    listInstalledApps,
    namespaceStore: emptyNamespaces,
    appApplier: noopApplier,
    underlyingSyncStateStore: memorySyncState(),
    exchangeIntervalMs: options.exchangeIntervalMs ?? 600_000,
    nudgeDebounceMs: 5,
    getDeviceSigner: () => (options.signer === undefined ? testSigner() : options.signer),
  });
}

/** A device key for the test machine. */
function testSigner(): DeviceSigner {
  return deviceSigner("dev_test", new Uint8Array(randomBytes(32)));
}

describe("a machine with no device key", () => {
  it("starts no channel, rather than a loop of refused requests", async () => {
    supervisor = await build({ apps: [{ appId: "aaa-app" }], signer: null });
    supervisor.start();
    expect(supervisor.status().perApp).toEqual([]);
    supervisor.rescan();
    expect(supervisor.status().perApp).toEqual([]);
  });
});

describe("stop() during a drain", () => {
  it("waits for the round in flight instead of leaving it running", async () => {
    // Test 17. Observed at the cloud rather than at the supervisor, because
    // "nothing is still running" is a claim about requests that have not come
    // back yet — and the old `stop()`, which only cleared timers, would leave
    // one in flight and resolve anyway.
    let inFlight = 0;
    let served = 0;
    const server = createServer((req, res) => {
      inFlight += 1;
      // Slow enough that stop() lands while a round is genuinely mid-request.
      setTimeout(() => {
        served += 1;
        inFlight -= 1;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
      }, 120);
      req.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      supervisor = await build({
        apps: [{ appId: "aaa-app" }],
        exchangeIntervalMs: 5,
        cloudUrl: `http://127.0.0.1:${port}`,
      });
      supervisor.start();
      // Long enough for a tick to fire and a request to be outstanding.
      await new Promise((r) => setTimeout(r, 60));
      expect(inFlight, "a round should be in flight for this to mean anything").toBeGreaterThan(0);

      await supervisor.stop();

      expect(inFlight, "stop() resolved with a round still on the wire").toBe(0);
      expect(supervisor.status().syncPaused).toBe(true);
      expect(supervisor.status().perApp).toEqual([]);

      // And nothing rearms: no further requests after it returned.
      const settled = served;
      await new Promise((r) => setTimeout(r, 120));
      expect(served, "a stopped supervisor kept exchanging").toBe(settled);
      supervisor = null;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});

describe("rescan() dropping an app during its drain", () => {
  it("stops that app's channel and leaves the others running", async () => {
    // N8.3. `stop()` had this covered through `paused`; `rescan()` did not.
    // Clearing an entry's timers stops the *next* tick and says nothing about
    // the drain running right now — and a tick's drain is a whole `sync()` with
    // no `maxRounds`. So uninstalling an app left its `sync()` issuing requests
    // against a channel that no longer existed and writing `sync_state` rows
    // for an app that was gone.
    //
    // Observed at the cloud, like the `stop()` case above and for the same
    // reason: "nothing is still running for this app" is a claim about requests,
    // and the supervisor's own status reports the entry as absent either way.
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      setTimeout(() => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
      }, 40);
      req.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const forApp = (appId: string) => requests.filter((u) => u.includes(`/apps/${appId}/`)).length;

    let installed = [{ appId: "aaa-app" }, { appId: "bbb-app" }];
    try {
      supervisor = await build({
        apps: [
          { appId: "aaa-app" },
          { appId: "bbb-app" },
        ],
        installed: () => installed,
        exchangeIntervalMs: 5,
        cloudUrl: `http://127.0.0.1:${port}`,
      });
      supervisor.start();
      await new Promise((r) => setTimeout(r, 80));
      expect(forApp("bbb-app"), "the dropped app must be busy for this to mean anything")
        .toBeGreaterThan(0);

      // Uninstall, the way a registry-change handler does it.
      installed = [{ appId: "aaa-app" }];
      supervisor.rescan();
      expect(supervisor.status().perApp.map((p) => p.appId)).not.toContain("bbb-app");

      // One round may still be on the wire when rescan returns — it is
      // synchronous by contract and cannot await the drain. What it must do is
      // make that drain the *last* one.
      await new Promise((r) => setTimeout(r, 120));
      const settled = forApp("bbb-app");
      await new Promise((r) => setTimeout(r, 200));
      expect(forApp("bbb-app"), "the uninstalled app kept draining").toBe(settled);

      // …and the app that is still installed is unaffected, so this is a
      // targeted stop rather than everything grinding to a halt. Polled rather
      // than slept on: every exchange here fails, so the survivor's backoff is
      // growing and a fixed window would be racing it.
      const others = forApp("aaa-app");
      const deadline = Date.now() + 5_000;
      while (forApp("aaa-app") === others && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(forApp("aaa-app"), "the surviving app stopped syncing too").toBeGreaterThan(others);
      // The dropped one made no progress across that whole window either.
      expect(forApp("bbb-app")).toBe(settled);
    } finally {
      await supervisor?.stop();
      supervisor = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});

describe("the device signature on outbound sync", () => {
  /**
   * Every data-plane call carries this machine's device signature. The
   * signature names the machine, and the cloud's record of the device names
   * the person it syncs for, so no app secret and no end-user token travel.
   *
   * Observed at the wire rather than by reaching into `makeSignerFor`: what
   * matters is the header that arrives, and a signer asserted in isolation can
   * be correct while nothing calls it.
   */
  async function captureRequests() {
    const seen: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: { ...req.headers }, body: Buffer.concat(chunks) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { seen, port, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("signs every channel's requests with the device key, which the public half verifies", async () => {
    const cap = await captureRequests();
    const signer = testSigner();
    try {
      supervisor = await build({
        apps: [{ appId: "aaa-app" }],
        exchangeIntervalMs: 5,
        cloudUrl: `http://127.0.0.1:${cap.port}`,
        signer,
      });
      supervisor.start();
      await new Promise((r) => setTimeout(r, 120));

      expect(cap.seen.length, "no request reached the cloud").toBeGreaterThan(0);
      const key = createPublicKey({ key: Buffer.from(signer.publicKeySpki, "base64"), type: "spki", format: "der" });
      for (const { method, url, headers, body } of cap.seen) {
        expect(headers["x-starkeep-device-id"]).toBe("dev_test");
        expect(headers["x-starkeep-user-token"]).toBeUndefined();
        expect(headers["x-starkeep-app-sig"]).toBeUndefined();
        const appId = String(headers["x-starkeep-app-id"]);
        const subPath = url.slice(`/apps/${appId}`.length);
        const message = signedMessage(
          appId,
          method,
          subPath,
          Number(headers["x-starkeep-app-ts"]),
          method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body),
        );
        expect(
          verify(null, message, key, Buffer.from(String(headers["x-starkeep-device-sig"]), "base64")),
          `${method} ${url}`,
        ).toBe(true);
      }

      // The Drive channel is not a special case: it carries every shared record.
      const appIds = new Set(cap.seen.map((r) => r.headers["x-starkeep-app-id"]));
      expect(appIds).toContain(DRIVE_APP_ID);
      expect(appIds).toContain("aaa-app");
    } finally {
      await supervisor?.stop();
      supervisor = null;
      await cap.close();
    }
  }, 20_000);
});
