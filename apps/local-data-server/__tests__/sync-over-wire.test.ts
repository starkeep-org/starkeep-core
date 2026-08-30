/**
 * Tier-1 sync end-to-end across the wire (plan §4): two real
 * local-data-server processes (A, B) exchanging through one fake cloud over
 * HTTP, with real SQLite + FS storage on both sides. Replaces the deleted
 * scripts/test-sync.sh smoke script as a real test.
 *
 * Exchanges are driven deterministically: tick interval is effectively
 * infinite, and convergence is forced with explicit /sync/now rounds.
 * (Both servers run with a small syncMaxItems, so multi-record flows also
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
import { DatabaseSync } from "node:sqlite";
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
  putAppFile,
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
 * Drive both servers until they stop moving.
 *
 * Requires **two consecutive quiet rounds**, not one. A single quiet round does
 * not mean converged: creating a record nudges a background exchange on a 50 ms
 * debounce, and `transferFile` returns false for a key whose transfer is
 * already in flight — so a `/sync/now` round can truthfully report nothing
 * applied and nothing shipped while the background round is mid-transfer.
 * Stopping there hands the test a half-finished state, which shows up as a
 * missing blob or a 404 on a file URL, only under load, only sometimes.
 *
 * The short pause between the two checks is what gives the in-flight transfer
 * somewhere to land.
 */
async function converge(maxRounds = 30): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < maxRounds; i++) {
    const a = await syncNow(driveA);
    const b = await syncNow(driveB);
    const still =
      a.applied === 0 && a.shipped === 0 && b.applied === 0 && b.shipped === 0;
    if (!still) {
      quiet = 0;
      continue;
    }
    quiet += 1;
    if (quiet >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    syncMaxItems: PAGE_LIMIT,
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

  it("drains more than one round of records with the small item cap", async () => {
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
    // Drain to the actual end state rather than to a single quiet round.
    //
    // `converge()` alone is not sufficient here and the difference is a real
    // race, not test flakiness for its own sake: creating a record nudges a
    // background exchange on a 50 ms debounce, and `transferFile` returns false
    // for a key whose transfer is already in flight. So a `/sync/now` round can
    // truthfully report "nothing shipped" while a concurrent background round is
    // mid-transfer, and converge() reads that as done. Under parallel test load
    // that happened often enough to fail this assertion intermittently.
    // (The idle pull interval is 600 s in this config, so rounds only happen
    // when driven — hence converge() inside the retry rather than beside it.)
    await eventually(async () => {
      await converge();
      const ids = new Set((await listRecords(driveB)).map((r) => r.id));
      for (const id of created) expect(ids.has(id)).toBe(true);
    });

    // No single exchange round carried more than the page limit.
    for (const entry of cloud.exchangeLog) {
      expect(entry.inRecords + entry.inAppRows).toBeLessThanOrEqual(PAGE_LIMIT);
      expect(entry.outRecords + entry.outAppRows).toBeLessThanOrEqual(PAGE_LIMIT);
    }
    // …and every record got there. With a per-round cap of PAGE_LIMIT and more
    // than PAGE_LIMIT records, that *entails* multiple shipping rounds, which is
    // what this test is about. Asserting the entailment rather than counting
    // rounds directly keeps it independent of how the background nudges happen
    // to interleave.
    const shippedIn = cloud.exchangeLog.reduce((n, e) => n + e.inRecords, 0);
    expect(shippedIn).toBeGreaterThanOrEqual(count);
    expect(count).toBeGreaterThan(PAGE_LIMIT);
  });
});

describe("two nodes producing the same file", () => {
  /**
   * The regression test for the sync wedge of 2026-08-29.
   *
   * `shared_records` enforces `UNIQUE(original_filename, content_hash)` over
   * live rows. Before record ids were content-addressed, two nodes that
   * produced the same file each minted their own ULID, and applying the second
   * one raised that constraint out of the exchange loop — which stopped **all**
   * sync for the app, in both directions, permanently, while `/sync/now` went
   * on answering 200.
   *
   * This is not a contrived state. Deriving on each device rather than shipping
   * derived bytes is the design, so two devices sweeping one library both
   * derive the same rendition; two devices importing one SD card both ingest
   * the same photo. Either way the second copy to arrive is the one that used
   * to break everything.
   *
   * Found by a tier-3 cloud journey, which is an expensive place to find it.
   * That is why it is asserted here.
   */
  it("converge on one record instead of wedging the exchange", { timeout: 30_000 }, async () => {
    const bytes = "same-bytes-on-both-nodes";
    const fileName = "collision.jpg";

    // Independently, with no sync in between — the race the bug needs.
    const { record: onA } = await createRecordWithBytes(driveA, { bytes, fileName });
    const { record: onB } = await createRecordWithBytes(driveB, { bytes, fileName });

    // Same file, same id, without either node having heard of the other. This
    // is the property the whole fix rests on; everything below is what it buys.
    expect(onB.id).toBe(onA.id);

    // The exchange completes. Before the fix this threw and `converge` never
    // finished, because no round could get past the colliding row.
    await converge();

    // One record, not two, and it is that one.
    const seenByA = (await listRecords(driveA)).filter((r) => r.original_filename === fileName);
    const seenByB = (await listRecords(driveB)).filter((r) => r.original_filename === fileName);
    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);
    expect(seenByA[0]!.id).toBe(onA.id);
    expect(seenByB[0]!.id).toBe(onA.id);

    // And it is a real record on both sides, not a row that merged into a
    // broken state: the bytes are resident and readable from each node's own
    // object store.
    expect(await fetchBytes(driveA, onA.id)).toBe(bytes);
    expect(await fetchBytes(driveB, onA.id)).toBe(bytes);
  });

  it("keeps sync working afterwards, which is what the wedge took away", { timeout: 30_000 }, async () => {
    // The collision's cost was never the one record — it was that every later
    // round died at the same place. A record created after the collision has to
    // still cross the wire.
    const { record } = await createRecordWithBytes(driveA, {
      bytes: "after-the-collision",
      fileName: "after-collision.jpg",
    });
    await converge();

    const arrived = (await listRecords(driveB)).find((r) => r.id === record.id);
    expect(arrived).toBeDefined();
    expect(await fetchBytes(driveB, record.id)).toBe("after-the-collision");
  });

  /**
   * The other half of the same decision, and the reason `parent_id` is in the
   * key rather than only the filename and the bytes.
   *
   * Two copies of one photo under different names are two legal records. A
   * derived file is named after its *parent's filename*, and nothing makes a
   * filename unique, so two parents can hand their renditions one name; strip
   * EXIF on the way — which every derivation does — and the derived bytes are
   * identical too. Keyed on filename and bytes alone, those two renditions are
   * one record, and `parent_id` is a single scalar column, so the second one
   * registered does not join the first: it takes the first original's rendition
   * away, on one node, with no sync involved and nothing reported.
   */
  it("keeps two originals' identical renditions apart", { timeout: 30_000 }, async () => {
    const originalBytes = "one-photo-two-copies";
    const derivedBytes = "one-rendition-either-way";
    const derivedName = "thumb_copy.jpg";

    const { record: copyOne } = await createRecordWithBytes(driveA, {
      bytes: originalBytes,
      fileName: "copy-one.jpg",
    });
    const { record: copyTwo } = await createRecordWithBytes(driveA, {
      bytes: originalBytes,
      fileName: "copy-two.jpg",
    });
    expect(copyTwo.id).not.toBe(copyOne.id);

    const { record: fromOne } = await createRecordWithBytes(driveA, {
      bytes: derivedBytes,
      fileName: derivedName,
      parentId: copyOne.id,
    });
    const { record: fromTwo } = await createRecordWithBytes(driveA, {
      bytes: derivedBytes,
      fileName: derivedName,
      parentId: copyTwo.id,
    });

    // Two records, each still under the original it came from. Keyed without
    // the parent these are one id, and the second registration overwrites the
    // first row's `parent_id` — so this assertion is the whole point.
    expect(fromTwo.id).not.toBe(fromOne.id);
    expect(fromOne.parent_id).toBe(copyOne.id);
    expect(fromTwo.parent_id).toBe(copyTwo.id);

    // Each original still has its own rendition and only its own.
    for (const [parent, child] of [
      [copyOne, fromOne],
      [copyTwo, fromTwo],
    ] as const) {
      const children = await listRecords(driveA, `?parentId=${encodeURIComponent(parent.id)}`);
      expect(children.map((r) => r.id)).toEqual([child.id]);
    }

    // And both survive the wire intact rather than merging on the way.
    await converge();
    for (const [parent, child] of [
      [copyOne, fromOne],
      [copyTwo, fromTwo],
    ] as const) {
      const children = await listRecords(driveB, `?parentId=${encodeURIComponent(parent.id)}`);
      expect(children.map((r) => r.id)).toEqual([child.id]);
      expect(await fetchBytes(driveB, child.id)).toBe(derivedBytes);
    }
  });

  /**
   * Parentage narrows the key, so it has to be checked that it does not narrow
   * away the convergence the key exists for. Two nodes deriving one rendition
   * from one parent is the production shape — deriving on each device rather
   * than shipping derived bytes is the design — and the child ids agree only
   * because the parent id does.
   */
  it("still converges when two nodes derive one rendition from one parent", { timeout: 30_000 }, async () => {
    const { record: parent } = await createRecordWithBytes(driveA, {
      bytes: "the-shared-original",
      fileName: "shared-original.jpg",
    });
    await converge();

    const derived = "the-same-rendition";
    const derivedName = "thumb_shared-original.jpg";
    const { record: onA } = await createRecordWithBytes(driveA, {
      bytes: derived,
      fileName: derivedName,
      parentId: parent.id,
    });
    const { record: onB } = await createRecordWithBytes(driveB, {
      bytes: derived,
      fileName: derivedName,
      parentId: parent.id,
    });
    expect(onB.id).toBe(onA.id);

    await converge();
    for (const node of [driveA, driveB]) {
      const children = await listRecords(node, `?parentId=${encodeURIComponent(parent.id)}`);
      expect(children.map((r) => r.id)).toEqual([onA.id]);
      expect(await fetchBytes(node, onA.id)).toBe(derived);
    }
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

describe("app-specific files across the wire", () => {
  const filesManifest = testAppManifest({ id: "files-app" });
  let filesA: InstalledApp;
  let filesB: InstalledApp;

  beforeAll(async () => {
    filesA = await installApp(serverA, filesManifest);
    filesB = await installApp(serverB, filesManifest);
    cloud.installApp(filesManifest);
  });

  /** Resolve an app-private file's bytes through the presigned GET, or null on 404. */
  async function coverBytes(app: InstalledApp, subKey: string): Promise<string | null> {
    const res = await app.fetch(`/app-data/files/${subKey}`);
    if (res.status === 404) return null;
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const bytes = await fetch(url);
    expect(bytes.status).toBe(200);
    return bytes.text();
  }

  it("a cover set on A uploads to the cloud and resolves on B with its bytes", { timeout: 30_000 }, async () => {
    await putAppFile(filesA, "cover", "cover-from-A", "image/png");

    // Drained to the end state rather than trusting one quiet round.
    // `converge()` stops when a round reports nothing applied and nothing
    // shipped, and that is not the same as "finished": creating a file nudges a
    // background exchange on a 50 ms debounce, and `transferFile` returns false
    // for a key whose transfer is already in flight — so a `/sync/now` round can
    // truthfully report quiet while the background round is mid-transfer.
    await eventually(async () => {
      await converge();
      // Reached the cloud: the index row landed in the cloud-side app table.
      const cloudKeys = cloud
        .appRows("files-app", "_starkeep_sync_records")
        .map((r) => r["object_storage_key"]);
      expect(cloudKeys).toContain("apps/files-app/syncable/cover");
      // And the blob is resident in cloud storage.
      expect(await cloud.hasBlob("apps/files-app/syncable/cover")).toBe(true);
    });

    // Came down to B: existence (index) + bytes (blob) both resident locally.
    await eventually(async () => {
      await converge();
      expect(await coverBytes(filesB, "cover")).toBe("cover-from-A");
    });
  });

  it("a cover set on the cloud syncs down to a local server", { timeout: 30_000 }, async () => {
    // Originates the write on the cloud side, as the cloud-served app would
    // via the broker's presign → upload → register flow.
    await cloud.setAppFile("files-app", "banner", "cover-from-cloud", "image/png");

    await eventually(async () => {
      await converge();
      expect(await coverBytes(filesA, "banner")).toBe("cover-from-cloud");
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

    // Fails for every round this call makes, not just the first. `/sync/now`
    // drains in rounds and no longer reports a round whose transfer failed as
    // complete, so a single-shot failure is repaired inside the same call and
    // the staged state is never observable from outside.
    cloud.failures.blobGets = 100;
    await syncNow(driveB); // blob download fails → staged, watermark held

    const bytesWhileStaged = await driveB.fetch(`/data/records/${record.id}/file-url`);
    expect(bytesWhileStaged.status).not.toBe(200);

    // Next rounds repair: blob lands and the record is fully resident.
    cloud.failures.blobGets = 0;
    await eventually(async () => {
      await syncNow(driveB);
      expect(await fetchBytes(driveB, record.id)).toBe("staged-bytes");
    });
  });
});

describe("verification and repair across the wire", () => {
  /**
   * Delete a shared record from a running server's SQLite, behind its back.
   *
   * The point of the case is a loss the node itself did not perform — a
   * corrupted page, a restore from an older backup, a bug in something else. A
   * deletion the server *made* would write a tombstone and sync it, which is
   * ordinary convergence and not what the digest exists for.
   */
  function loseSharedRecord(server: LocalDataServer, id: string): void {
    const db = new DatabaseSync(join(server.starkeepDir, "data.db"));
    try {
      db.prepare("DELETE FROM shared_records WHERE id = ?").run(id);
    } finally {
      db.close();
    }
  }

  async function verifyDrive(app: InstalledApp) {
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
    const drive = body.channels.find((c) => c.appId === "starkeep-drive");
    expect(drive, "the Drive channel must be among the verified channels").toBeDefined();
    expect(drive!.error).toBeNull();
    expect(drive!.result?.supported, "the peer must have answered with a digest").toBe(true);
    return drive!.result!;
  }

  it("finds a row lost from the middle of B's table and repairs it", { timeout: 60_000 }, async () => {
    // The whole digest/repair mechanism has only ever run in-process. Over the
    // wire it has three more places to fail than the engine tests can see: the
    // digest has to survive JSON both ways, the peer has to be a responder that
    // actually computes buckets rather than a harness, and the repair floor has
    // to reach the SQLite state store and come back out on the next tick.
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      const { record } = await createRecordWithBytes(driveA, {
        bytes: `verify-bytes-${i}`,
        fileName: `verify-${i}.jpg`,
      });
      created.push(record);
    }
    await converge();
    for (let i = 0; i < 3; i += 1) {
      expect(await fetchBytes(driveB, created[i]!.id)).toBe(`verify-bytes-${i}`);
    }

    // Lose the middle row on B. Not the newest: B's coverage watermark is a
    // MAX per author, so a loss underneath it leaves the watermark exactly
    // where it was and the cloud goes on believing B holds the row.
    const lost = created[1]!;
    loseSharedRecord(serverB, lost.id);

    // An ordinary round is blind to it, which is the finding the digest exists
    // for rather than a quirk of this test.
    const blind = await syncNow(driveB);
    expect(blind.applied).toBe(0);
    expect((await listRecords(driveB)).some((r) => r.id === lost.id)).toBe(false);

    // The check sees it, in the direction that means "am I whole?".
    const found = await verifyDrive(driveB);
    expect(found.missingLocally).toBeGreaterThan(0);
    expect(found.localRows).toBe(found.peerRows - 1);
    // And it is not confused about which side lost something: the cloud is
    // missing nothing, so the outbound repair trigger stays silent.
    expect(found.divergentBuckets).toBe(0);

    // The repair is armed, not performed — the ordinary scan carries it out on
    // the next round, through the path every other test already exercises.
    await eventually(async () => {
      await syncNow(driveB);
      expect(await fetchBytes(driveB, lost.id)).toBe("verify-bytes-1");
    });

    // …and the follow-up check reports whole, so the floor retired rather than
    // leaving the channel re-shipping that range forever.
    const after = await verifyDrive(driveB);
    expect(after.missingLocally).toBe(0);
    expect(after.divergentBuckets).toBe(0);
    expect(after.localRows).toBe(after.peerRows);
  });

  it("reports a healthy channel as whole, in both directions", async () => {
    await converge();
    const result = await verifyDrive(driveA);
    expect(result.divergentBuckets).toBe(0);
    expect(result.missingLocally).toBe(0);
    expect(result.localRows).toBe(result.peerRows);
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
    expect(quiet).toEqual({ applied: 0, shipped: 0, complete: true });
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
