/**
 * Tier-1 sync orchestration: the supervisor observed through the server's
 * /sync/* surface, exchanging with a real (fake-cloud) HTTP responder.
 *
 * Covers: /sync/now, /sync/pause, /sync/resume reflected in /sync/status;
 * backoff growth on failing exchanges and reset on success; nudge routing
 * (shared writes → Drive channel only, app-data writes → that app's channel
 * only — the 2026-06-01 fix); and the id-token auth gate (no token → no
 * exchanges, no 401 storm).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startLocalDataServer,
  startFakeCloud,
  fakeIdToken,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import {
  testAppManifest,
  installApp,
  builtinAppCreds,
  createRecordWithBytes,
  eventually,
  type InstalledApp,
} from "./helpers.js";

interface SyncStatus {
  enabled: boolean;
  syncPaused: boolean;
  perApp: Array<{
    appId: string;
    lastExchangeAt: string | null;
    lastError: string | null;
    backoffMs: number;
  }>;
  lastExchangeAt: string | null;
  lastError: string | null;
  backoffMs: number;
}

// /sync/* is on the HMAC-authenticated data plane (not loopback-exempt), so
// every call goes through an installed app's signed fetch.
async function syncStatus(app: InstalledApp): Promise<SyncStatus> {
  const res = await app.fetch("/sync/status");
  expect(res.status).toBe(200);
  return (await res.json()) as SyncStatus;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("nudge routing and pause/resume (long tick interval)", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let app: InstalledApp;

  // Ticks effectively never fire (10 min); only nudges (50 ms debounce) and
  // explicit /sync/now drive exchanges, so the log unambiguously attributes
  // each exchange to its trigger.
  beforeAll(async () => {
    cloud = await startFakeCloud();
    server = await startLocalDataServer({
      config: {
        apiGatewayUrl: cloud.url,
        pullIntervalMs: 600_000,
        pushDebounceMs: 50,
      },
      auth: { idToken: fakeIdToken() },
    });
    const manifest = testAppManifest();
    app = await installApp(server, manifest);
    cloud.installApp(manifest);

    // Both engines fire a drain-nudge on creation; let those settle.
    await eventually(async () => {
      const status = await syncStatus(app);
      if (!status.perApp.every((e) => e.lastExchangeAt !== null)) {
        throw new Error("initial exchanges not settled");
      }
    });
    cloud.clearExchangeLog();
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it("runs one engine per channel: Drive plus the installed app", async () => {
    const status = await syncStatus(app);
    expect(status.enabled).toBe(true);
    expect(status.perApp.map((e) => e.appId).sort()).toEqual([
      "starkeep-drive",
      "testapp",
    ]);
  });

  it("a shared-record write nudges only the Drive channel", async () => {
    await createRecordWithBytes(app, { type: "image/jpeg" });
    await eventually(() => {
      const driveExchanges = cloud.exchangeLog.filter((e) => e.appId === "starkeep-drive");
      expect(driveExchanges.length).toBeGreaterThan(0);
      // The nudged exchange carries the new record up.
      expect(driveExchanges.some((e) => e.inRecords > 0)).toBe(true);
    });
    // Give a would-be misrouted nudge time to fire, then check it didn't.
    await sleep(300);
    expect(cloud.exchangeLog.filter((e) => e.appId === "testapp")).toEqual([]);
    cloud.clearExchangeLog();
  });

  it("an app-data write nudges only that app's channel", async () => {
    const insert = await app.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "nudge-1", body: "hi" } }),
    });
    expect(insert.status).toBeLessThan(300);

    await eventually(() => {
      const appExchanges = cloud.exchangeLog.filter((e) => e.appId === "testapp");
      expect(appExchanges.length).toBeGreaterThan(0);
      expect(appExchanges.some((e) => e.inAppRows > 0)).toBe(true);
    });
    await sleep(300);
    expect(cloud.exchangeLog.filter((e) => e.appId === "starkeep-drive")).toEqual([]);
    // The row actually landed cloud-side via the per-app channel.
    expect(cloud.appRows("testapp", "notes").map((r) => r["note_id"])).toContain("nudge-1");
    cloud.clearExchangeLog();
  });

  it("pause suppresses nudges and is visible in status; resume exchanges immediately", async () => {
    const pause = await app.fetch("/sync/pause", { method: "POST" });
    expect(pause.status).toBe(200);
    expect((await syncStatus(app)).syncPaused).toBe(true);

    await createRecordWithBytes(app, { type: "image/jpeg" });
    await sleep(400);
    expect(cloud.exchangeLog).toEqual([]);

    const resume = await app.fetch("/sync/resume", { method: "POST" });
    expect(resume.status).toBe(200);
    await eventually(async () => {
      const status = await syncStatus(app);
      expect(status.syncPaused).toBe(false);
      // The record written while paused made it up on the resume sync. Asserted
      // as the thing actually wanted, not as a count of exchanges: resume now
      // drains rather than running one round, so the number of requests is an
      // implementation detail and waiting on it raced the round that carried
      // the record.
      expect(
        cloud.exchangeLog.some((e) => e.appId === "starkeep-drive" && e.inRecords > 0),
      ).toBe(true);
    });
    cloud.clearExchangeLog();
  });

  it("/sync/now drives every engine and updates lastExchangeAt", async () => {
    const before = (await syncStatus(app)).lastExchangeAt;
    await sleep(10); // ensure a strictly newer ISO timestamp
    const res = await app.fetch("/sync/now", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: number;
      shipped: number;
      complete: boolean;
    };
    expect(body).toMatchObject({ applied: expect.any(Number), shipped: expect.any(Number) });
    // Every channel was driven. Asserted as coverage rather than as a request
    // count: a drain runs as many rounds as it needs, and pinning the number
    // would pin an implementation detail that changes with the round budget.
    expect(new Set(cloud.exchangeLog.map((e) => e.appId))).toEqual(
      new Set(["starkeep-drive", "testapp"]),
    );
    // Bounded, so the handler returns rather than holding the connection open
    // for a whole backlog. Nothing is owed here, so it drained.
    expect(body.complete).toBe(true);
    const after = (await syncStatus(app)).lastExchangeAt;
    expect(after).not.toBeNull();
    if (before !== null) expect(after! > before).toBe(true);
  });

  it("/sync/verify compares row counts on every channel", async () => {
    // The digest machinery has no other caller on this node. Without a route it
    // is unreachable here, and a hole in the middle of an author's range —
    // which no amount of syncing can find — would stay invisible on the laptop.
    const res = await app.fetch("/sync/verify", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: Array<{
        appId: string;
        result: {
          supported: boolean;
          localRows: number;
          peerRows: number;
          divergentBuckets: number;
          missingLocally: number;
        } | null;
        error: string | null;
      }>;
    };
    expect(new Set(body.channels.map((c) => c.appId))).toEqual(
      new Set(["starkeep-drive", "testapp"]),
    );
    for (const channel of body.channels) {
      expect(channel.error, channel.appId).toBeNull();
      expect(channel.result?.supported, channel.appId).toBe(true);
      // Both counts present and both directions answered — the point of the
      // route is that "is the cloud missing anything" and "am I missing
      // anything" are different questions with different answers.
      expect(typeof channel.result?.divergentBuckets).toBe("number");
      expect(typeof channel.result?.missingLocally).toBe("number");
    }
  });

  it("/sync/verify reports sync not configured rather than pretending", async () => {
    const res = await app.fetch("/sync/verify", { method: "GET" });
    expect(res.status).toBe(404);
  });
});

describe("backoff (short tick interval)", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let drive: InstalledApp;
  const INTERVAL = 150;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    server = await startLocalDataServer({
      config: {
        apiGatewayUrl: cloud.url,
        pullIntervalMs: INTERVAL,
        pushDebounceMs: 50,
      },
      auth: { idToken: fakeIdToken() },
    });
    drive = await builtinAppCreds(server, "starkeep-drive");
    await eventually(async () => {
      const status = await syncStatus(drive);
      if (status.lastExchangeAt === null) throw new Error("no exchange yet");
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it("backoff grows while exchanges fail and resets after a success", async () => {
    cloud.failures.allExchanges = true;
    await eventually(async () => {
      const status = await syncStatus(drive);
      expect(status.lastError).toMatch(/500/);
      // Doubled at least twice past the base interval.
      expect(status.backoffMs).toBeGreaterThanOrEqual(INTERVAL * 4);
    });

    cloud.failures.allExchanges = false;
    await eventually(async () => {
      const status = await syncStatus(drive);
      expect(status.lastError).toBeNull();
      expect(status.backoffMs).toBe(INTERVAL);
    });
  });
});

describe("auth gate (no id token)", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let drive: InstalledApp;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    // Cloud URL configured but no auth.json — the supervisor must not start.
    server = await startLocalDataServer({
      config: {
        apiGatewayUrl: cloud.url,
        pullIntervalMs: 100,
        pushDebounceMs: 25,
      },
    });
    drive = await builtinAppCreds(server, "starkeep-drive");
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await cloud?.close();
  });

  it("skips all exchanges and reports a disabled supervisor", async () => {
    // Plenty of would-be tick periods.
    await sleep(500);
    expect(cloud.exchangeLog).toEqual([]);

    const status = await syncStatus(drive);
    expect(status.enabled).toBe(false);
    expect(status.perApp).toEqual([]);
    expect(status.lastError).toBeNull();

    // Manual trigger is a clean no-op, not a 401 storm.
    const now = await drive.fetch("/sync/now", { method: "POST" });
    expect(now.status).toBe(200);
    expect(await now.json()).toEqual({ applied: 0, shipped: 0, complete: true });
    expect(cloud.exchangeLog).toEqual([]);
  });

  it("an expired token is treated as no token", async () => {
    const expired = await startLocalDataServer({
      config: { apiGatewayUrl: cloud.url, pullIntervalMs: 100, pushDebounceMs: 25 },
      auth: { idToken: fakeIdToken(-3600) },
    });
    const expiredDrive = await builtinAppCreds(expired, "starkeep-drive");
    try {
      await sleep(400);
      const status = await syncStatus(expiredDrive);
      expect(status.enabled).toBe(false);
      expect(cloud.exchangeLog).toEqual([]);
    } finally {
      await expired.stop();
    }
  });
});

/**
 * One engine, one drain — observed through the supervisor rather than the
 * runner underneath it.
 *
 * `engine-runner.test.ts` pins the coalescing itself. What it cannot show is
 * that the supervisor actually routes *every* trigger through it, and that is
 * the half that broke: a tick used to run a single `exchange()` and now runs an
 * unbounded multi-round drain, so a nudge, a `/sync/now` or a `/sync/verify`
 * arriving inside that window used to start a second loop against the same
 * `syncState` rows. Both loops read the watermarks and the repair floors, both
 * write them back, and the later write wins. A regressed watermark costs a
 * re-ship; a dropped repair floor is the only record that a hole still needs
 * filling, so losing it makes the repair report success and do nothing.
 *
 * The observable is the cloud's own view: one engine serializes its rounds, so
 * more than one exchange in flight for a channel means two loops were driving
 * it. Exchanges are slowed down deliberately — without that no trigger ever
 * arrives while a drain is still running, which is precisely why this class of
 * bug went unnoticed.
 */
describe("concurrent triggers on one engine", () => {
  let cloud: FakeCloud;
  let server: LocalDataServer;
  let app: InstalledApp;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    server = await startLocalDataServer({
      config: {
        apiGatewayUrl: cloud.url,
        pullIntervalMs: 600_000,
        pushDebounceMs: 25,
      },
      auth: { idToken: fakeIdToken() },
    });
    const manifest = testAppManifest();
    app = await installApp(server, manifest);
    cloud.installApp(manifest);
    await eventually(async () => {
      const status = await syncStatus(app);
      if (!status.perApp.every((e) => e.lastExchangeAt !== null)) {
        throw new Error("initial exchanges not settled");
      }
    });
  }, 60_000);

  afterAll(async () => {
    cloud.latency.exchangeDelayMs = 0;
    await server?.stop();
    await cloud?.close();
  });

  it("folds a nudge arriving mid-drain into the drain already running", async () => {
    cloud.latency.exchangeDelayMs = 120;
    cloud.clearExchangeLog();

    // A write while a /sync/now drain is in flight. The nudge it fires is a
    // request for the drain's *next* round to see the write, not a request for
    // a second drain — the running loop re-scans from the watermark every
    // round, so it will pick it up.
    const draining = app.fetch("/sync/now", { method: "POST" });
    await sleep(60);
    await createRecordWithBytes(app, { type: "image/jpeg" });
    await sleep(60);
    await createRecordWithBytes(app, { type: "image/jpeg" });
    expect((await draining).status).toBe(200);

    // Let the coalesced rerun finish before judging.
    await sleep(400);
    expect(cloud.peakConcurrentExchanges("starkeep-drive")).toBe(1);
    expect(cloud.peakConcurrentExchanges("testapp")).toBe(1);
  }, 30_000);

  it("keeps /sync/verify off the engine while a drain is running", async () => {
    cloud.latency.exchangeDelayMs = 120;
    cloud.clearExchangeLog();

    // verify() writes repair and inbound floors from a read of the same rows a
    // round is reading, so overlapping them is the floor-clobbering case
    // exactly. It waits its turn instead.
    const draining = app.fetch("/sync/now", { method: "POST" });
    await sleep(50);
    const verify = await app.fetch("/sync/verify", { method: "POST" });
    expect(verify.status).toBe(200);
    expect((await draining).status).toBe(200);

    expect(cloud.peakConcurrentExchanges("starkeep-drive")).toBe(1);
    expect(cloud.peakConcurrentExchanges("testapp")).toBe(1);
  }, 30_000);

  it("reports the job unfinished, and finishes it on the next call", async () => {
    // The contract `SYNC_NOW_MAX_ROUNDS` exists to create: the handler returns
    // rather than holding a connection open for a whole backlog, and the caller
    // polls while `complete` is false. A blob that will not upload produces the
    // same "not done" without needing a fifty-round backlog to get there — and
    // it is the case that used to answer `complete: true` with the photo still
    // on the phone, because the scan had drained even though nothing shipped.
    cloud.latency.exchangeDelayMs = 0;
    cloud.clearExchangeLog();
    cloud.failures.blobPuts = 100;
    await createRecordWithBytes(app, { type: "image/jpeg" });

    const stuck = await app.fetch("/sync/now", { method: "POST" });
    expect(stuck.status).toBe(200);
    expect(((await stuck.json()) as { complete: boolean }).complete).toBe(false);

    cloud.failures.blobPuts = 0;
    await eventually(async () => {
      const res = await app.fetch("/sync/now", { method: "POST" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { complete: boolean }).complete).toBe(true);
    });
  }, 30_000);

  it("stops a coalesced rerun when the sync is paused mid-drain", async () => {
    cloud.latency.exchangeDelayMs = 120;
    cloud.clearExchangeLog();

    const draining = app.fetch("/sync/now", { method: "POST" });
    await sleep(50);
    await createRecordWithBytes(app, { type: "image/jpeg" });
    const pause = await app.fetch("/sync/pause", { method: "POST" });
    expect(pause.status).toBe(200);
    expect((await draining).status).toBe(200);

    // A pause has to reach the rerun the nudge queued, not just fresh
    // triggers — otherwise "pause" means "pause in a moment", which on a
    // metered connection is the difference the setting exists to make.
    await sleep(300);
    const settled = cloud.exchangeLog.length;
    await sleep(300);
    expect(cloud.exchangeLog.length).toBe(settled);
    expect((await syncStatus(app)).syncPaused).toBe(true);

    cloud.latency.exchangeDelayMs = 0;
    expect((await app.fetch("/sync/resume", { method: "POST" })).status).toBe(200);
  }, 30_000);
});
