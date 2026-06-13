/**
 * Tier-1 sync end-to-end across the wire (plan §4): two real
 * local-data-server processes (A, B) exchanging through one fake cloud over
 * HTTP, with real SQLite + FS storage on both sides. Replaces the deleted
 * scripts/test-sync.sh smoke script as a real test.
 *
 * Exchanges are driven deterministically: tick interval is effectively
 * infinite, and convergence is forced with explicit /sync/now rounds.
 * (Both servers run with a small syncPageLimit, so multi-record flows also
 * exercise multi-round pagination drain.)
 *
 * Not covered here: shared-record LWW *update* conflict — there is no public
 * HTTP surface that mutates an existing shared record in place (metadata
 * lives in its own table; the watcher re-ingests modified files as new
 * records). The engine's S5 concurrent suite owns LWW semantics.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startLocalDataServer,
  startFakeCloud,
  fakeIdToken,
  type LocalDataServer,
  type FakeCloud,
} from "@starkeep/testkit";
import {
  builtinAppCreds,
  installApp,
  testAppManifest,
  createRecordWithBytes,
  listRecords,
  eventually,
  openSse,
  type InstalledApp,
} from "./helpers.js";

const PAGE_LIMIT = 5;

let cloud: FakeCloud;
let serverA: LocalDataServer;
let serverB: LocalDataServer;
let driveA: InstalledApp;
let driveB: InstalledApp;

async function syncNow(app: InstalledApp): Promise<{ applied: number; shipped: number }> {
  const res = await app.fetch("/sync/now", { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as { applied: number; shipped: number };
}

/**
 * Alternate /sync/now on A and B until both report a quiet round (nothing
 * shipped or applied) — multi-round by design so small pageLimits drain.
 */
async function converge(maxRounds = 30): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const a = await syncNow(driveA);
    const b = await syncNow(driveB);
    if (a.applied === 0 && a.shipped === 0 && b.applied === 0 && b.shipped === 0) return;
  }
  throw new Error(`did not converge within ${maxRounds} rounds`);
}

async function fetchBytes(app: InstalledApp, recordId: string): Promise<string> {
  const urlRes = await app.fetch(`/data/records/${recordId}/file-url`);
  expect(urlRes.status).toBe(200);
  const { url } = (await urlRes.json()) as { url: string };
  const bytes = await fetch(url);
  expect(bytes.status).toBe(200);
  return bytes.text();
}

function serverConfig(cloudUrl: string) {
  return {
    apiGatewayUrl: cloudUrl,
    pullIntervalMs: 600_000,
    pushDebounceMs: 50,
    syncPageLimit: PAGE_LIMIT,
  };
}

beforeAll(async () => {
  cloud = await startFakeCloud();
  serverA = await startLocalDataServer({
    config: serverConfig(cloud.url),
    auth: { idToken: fakeIdToken() },
  });
  serverB = await startLocalDataServer({
    config: serverConfig(cloud.url),
    auth: { idToken: fakeIdToken() },
  });
  driveA = await builtinAppCreds(serverA, "starkeep-drive");
  driveB = await builtinAppCreds(serverB, "starkeep-drive");
}, 60_000);

afterAll(async () => {
  await serverA?.stop();
  await serverB?.stop();
  await cloud?.close();
});

describe("shared records across the wire", () => {
  it("a record created on A arrives on B with its blob resident, kicking B's /events", { timeout: 30_000 }, async () => {
    const sseB = openSse(`${serverB.url}/events`);
    try {
      const { record } = await createRecordWithBytes(driveA, {
        bytes: "wire-bytes-1",
        fileName: "wire-1.jpg",
      });
      await converge();

      const onB = await listRecords(driveB);
      const arrived = onB.find((r) => r.id === record.id);
      expect(arrived).toBeDefined();
      expect(arrived!.original_filename).toBe("wire-1.jpg");

      // Blob is resident on B, served from B's own object store.
      expect(await fetchBytes(driveB, record.id)).toBe("wire-bytes-1");

      // The sync-applied remote change kicked B's SSE stream with an empty
      // payload (the deferred half of the /events contract).
      await eventually(() => {
        expect(sseB.dataEvents.length).toBeGreaterThan(0);
      });
      expect(sseB.dataEvents.every((d) => d === "")).toBe(true);
    } finally {
      await sseB.close();
    }
  });

  it("a watcher tombstone on A removes the record from B", async () => {
    const watchDir = await mkdtemp(join(tmpdir(), "starkeep-wire-watch-"));
    try {
      await writeFile(join(watchDir, "doomed.txt"), "doomed-bytes");
      const watchRes = await fetch(`${serverA.url}/watches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directoryPath: watchDir }),
      });
      expect(watchRes.status).toBe(200);

      await converge();
      const onB = await listRecords(driveB);
      const doomed = onB.find((r) => r.original_filename === "doomed.txt");
      expect(doomed).toBeDefined();

      // Delete on disk → watcher tombstones on A → tombstone propagates.
      await unlink(join(watchDir, "doomed.txt"));
      await eventually(async () => {
        const onA = await listRecords(driveA);
        expect(onA.map((r) => r.id)).not.toContain(doomed!.id);
      });
      await converge();
      const afterB = await listRecords(driveB);
      expect(afterB.map((r) => r.id)).not.toContain(doomed!.id);
    } finally {
      await rm(watchDir, { recursive: true, force: true });
    }
  });

  it("drains more than one page of records with the small pageLimit", async () => {
    const count = PAGE_LIMIT * 2 + 2;
    // Clear before creating: the 50 ms debounce nudge starts shipping pages
    // while the creation loop is still running, and those rounds count too.
    cloud.clearExchangeLog();
    const created: string[] = [];
    for (let i = 0; i < count; i++) {
      const { record } = await createRecordWithBytes(driveA, {
        bytes: `page-bytes-${i}`,
        fileName: `page-${i}.jpg`,
      });
      created.push(record.id);
    }
    await converge();

    // No single exchange round carried more than the page limit.
    for (const entry of cloud.exchangeLog) {
      expect(entry.inRecords + entry.inAppRows).toBeLessThanOrEqual(PAGE_LIMIT);
      expect(entry.outRecords + entry.outAppRows).toBeLessThanOrEqual(PAGE_LIMIT);
    }
    // …and it took more than one shipping round to drain.
    expect(cloud.exchangeLog.filter((e) => e.inRecords > 0).length).toBeGreaterThan(1);

    const onB = await listRecords(driveB);
    const idsOnB = new Set(onB.map((r) => r.id));
    for (const id of created) expect(idsOnB.has(id)).toBe(true);
  });
});

describe("app-specific rows across the wire", () => {
  const manifest = testAppManifest();
  let appA: InstalledApp;

  it("rows from A reach the cloud but do not land on B until the app is installed there", async () => {
    appA = await installApp(serverA, manifest);
    cloud.installApp(manifest);

    const insert = await appA.fetch("/app-data/db/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row: { note_id: "wire-note", body: "from A" } }),
    });
    expect(insert.status).toBe(200);

    await converge();
    // The row is in the cloud responder's app table…
    expect(cloud.appRows("testapp", "notes").map((r) => r["note_id"])).toContain("wire-note");
    // …but B runs no engine for the app (not installed there): only Drive.
    const statusB = await driveB.fetch("/sync/status");
    const { perApp } = (await statusB.json()) as { perApp: Array<{ appId: string }> };
    expect(perApp.map((e) => e.appId)).toEqual(["starkeep-drive"]);
  });

  it("installing the app on B backfills the rows", async () => {
    const appB = await installApp(serverB, manifest);
    await converge();
    await eventually(async () => {
      const rows = await appB.fetch("/app-data/db/notes");
      expect(rows.status).toBe(200);
      const { rows: data } = (await rows.json()) as { rows: Array<Record<string, unknown>> };
      expect(data.map((r) => r["note_id"])).toContain("wire-note");
    });
  });
});

describe("blob staging across the wire", () => {
  it("a one-shot blob failure stages the record on B and the next round repairs it", async () => {
    const { record } = await createRecordWithBytes(driveA, {
      bytes: "staged-bytes",
      fileName: "staged.jpg",
    });
    await syncNow(driveA); // record + blob now in the cloud

    cloud.failures.blobGets = 1;
    await syncNow(driveB); // blob download fails once → staged, watermark held

    const bytesWhileStaged = await driveB.fetch(`/data/records/${record.id}/file-url`);
    expect(bytesWhileStaged.status).not.toBe(200);

    // Next rounds repair: blob lands and the record is fully resident.
    await eventually(async () => {
      await syncNow(driveB);
      expect(await fetchBytes(driveB, record.id)).toBe("staged-bytes");
    });
  });
});

describe("restart durability", () => {
  it("B restarts mid-stream, restores watermarks, and converges without a re-ship storm", { timeout: 60_000 }, async () => {
    await converge();

    // Restart B on the same data dir and port.
    const { starkeepDir, port } = serverB;
    await serverB.stopKeepData();
    serverB = await startLocalDataServer({ starkeepDir, port });
    driveB = await builtinAppCreds(serverB, "starkeep-drive");

    cloud.clearExchangeLog();
    const quiet = await syncNow(driveB);
    // Watermarks/HLC came back from the SQLite state store: nothing re-ships,
    // nothing re-applies.
    expect(quiet).toEqual({ applied: 0, shipped: 0 });
    expect(
      cloud.exchangeLog.filter((e) => e.appId === "starkeep-drive" && e.inRecords > 0),
    ).toEqual([]);

    // And new writes still converge after the restart.
    const { record } = await createRecordWithBytes(driveA, {
      bytes: "post-restart-bytes",
      fileName: "post-restart.jpg",
    });
    await converge();
    expect(await fetchBytes(driveB, record.id)).toBe("post-restart-bytes");
  });
});
