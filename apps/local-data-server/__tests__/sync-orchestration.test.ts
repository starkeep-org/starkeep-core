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
    await createRecordWithBytes(app, { type: "jpg" });
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

    await createRecordWithBytes(app, { type: "jpg" });
    await sleep(400);
    expect(cloud.exchangeLog).toEqual([]);

    const resume = await app.fetch("/sync/resume", { method: "POST" });
    expect(resume.status).toBe(200);
    await eventually(async () => {
      const status = await syncStatus(app);
      expect(status.syncPaused).toBe(false);
      // resume() exchanges every engine right away.
      expect(cloud.exchangeLog.length).toBeGreaterThanOrEqual(2);
    });
    // The record written while paused made it up on the resume exchange.
    expect(
      cloud.exchangeLog.some((e) => e.appId === "starkeep-drive" && e.inRecords > 0),
    ).toBe(true);
    cloud.clearExchangeLog();
  });

  it("/sync/now exchanges every engine and updates lastExchangeAt", async () => {
    const before = (await syncStatus(app)).lastExchangeAt;
    await sleep(10); // ensure a strictly newer ISO timestamp
    const res = await app.fetch("/sync/now", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number; shipped: number };
    expect(body).toMatchObject({ applied: expect.any(Number), shipped: expect.any(Number) });
    expect(cloud.exchangeLog.map((e) => e.appId).sort()).toEqual([
      "starkeep-drive",
      "testapp",
    ]);
    const after = (await syncStatus(app)).lastExchangeAt;
    expect(after).not.toBeNull();
    if (before !== null) expect(after! > before).toBe(true);
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
    expect(await now.json()).toEqual({ applied: 0, shipped: 0 });
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
