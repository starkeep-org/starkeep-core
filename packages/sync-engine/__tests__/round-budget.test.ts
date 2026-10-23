/**
 * Round sizing: the byte budget, the item cap, and concurrent blob transfer.
 *
 * Rows travel ahead of their files, so rows are bounded by the item cap alone.
 * Uploads are not part of a round at all: the uploader moves them beside it,
 * in its own lanes. These tests pin the consequences:
 *
 *   1. Rows spend none of the byte budget, and a round uploads nothing.
 *   2. A file larger than any budget still goes, and smaller files go beside
 *      it rather than behind it.
 *   3. Uploading concurrently does not weaken the contiguous-prefix rule: the
 *      peer's bytes watermark still stops at an author's first missing file.
 *   4. Downloads keep the round's transfer width.
 */

import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { describe, it, expect } from "vitest";
import {
  compareHLC,
  createDataRecord,
  generateId,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";
import { uploadAfterRound, uploaderClockFor } from "./sync-test-harness/uploader-clock.js";
import type { SyncEngine, SyncStateStore, Watermarks } from "../src/types.js";

type Side = Awaited<ReturnType<typeof buildSide>>;

const MB = 1024 * 1024;

async function twoSides() {
  let t = 0;
  const wallClock = () => t++;
  return {
    local: await buildSide({ role: "local", nodeId: "L", wallClock, appId: "photos" }),
    cloud: await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: "photos" }),
  };
}

function engineFor(
  local: Side,
  cloud: Side,
  syncState: SyncStateStore,
  opts: { maxBytes?: number; maxItems?: number; transferConcurrency?: number } = {},
) {
  const transport = createInProcessSyncTransport({
    databaseAdapter: cloud.db,
    clock: cloud.clock,
    objectStorage: cloud.storage,
    syncSharedRecords: true,
  });
  return createSyncEngine({
    localDatabaseAdapter: local.db,
    localObjectStorage: local.storage,
    remoteObjectStorage: cloud.storage,
    transport,
    clock: local.clock,
    syncState,
    syncSharedRecords: true,
    uploaderTimers: uploaderClockFor(local),
    ...opts,
  });
}

/** Run the uploads the rounds so far made owed, and let any backoff run out. */
async function upload(local: Side, engine: SyncEngine): Promise<void> {
  await uploadAfterRound(engine, uploaderClockFor(local));
}

/** Sync, upload, and sync again so the peer reports what arrived. */
async function syncAndUpload(local: Side, engine: SyncEngine): Promise<void> {
  await engine.sync();
  await upload(local, engine);
  await engine.sync();
}

/** A record with a real blob of `sizeBytes` staged in local storage. */
async function seedBlobRecord(side: Side, sizeBytes: number): Promise<StarkeepId> {
  const id = generateId() as StarkeepId;
  const key = `shared/image/${id}`;
  await side.storage.put(key, new Uint8Array(8));
  await side.db.put({
    ...createDataRecord(
      {
        type: "image/jpeg",
        originAppId: "photos",
        contentHash: `sha256:${id}`,
        objectStorageKey: key,
        mimeType: "image/jpeg",
        sizeBytes,
      },
      side.clock,
    ),
    id,
  });
  return id;
}

/** A record carrying no blob at all — costs no byte budget. */
async function seedBlobless(side: Side): Promise<StarkeepId> {
  const id = generateId() as StarkeepId;
  await side.db.put({
    ...createDataRecord(
      {
        type: "image/jpeg",
        originAppId: "photos",
        contentHash: `sha256:${id}`,
        objectStorageKey: "",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      },
      side.clock,
    ),
    id,
  });
  return id;
}

/** A blob-carrying record attributed to a specific author. */
async function seedAuthored(side: Side, nodeId: string, wallTime: number): Promise<StarkeepId> {
  const id = generateId() as StarkeepId;
  const key = `shared/image/${id}`;
  await side.storage.put(key, new Uint8Array(8));
  const base = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: `sha256:${id}`,
      objectStorageKey: key,
      mimeType: "image/jpeg",
      sizeBytes: 1024,
    },
    side.clock,
  );
  await side.db.put({ ...base, id, updatedAt: { wallTime, counter: 0, nodeId } });
  return id;
}

describe("round budget", () => {
  it("ships every row in one round and uploads nothing inside it", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 10; i += 1) await seedBlobRecord(local, 3 * MB);

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 10 * MB,
      maxItems: 1000,
    });
    const result = await engine.exchange();

    expect(result.shipped).toBe(10);
    expect(result.outboundHasMore).toBe(false);
    // Uploads are the uploader's: no round waits on one.
    expect(result.bytesHasMore).toBe(false);
    expect(engine.uploader.stats().sent.count).toBe(0);
  });

  it("does not charge blob-less rows against the byte budget", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 50; i += 1) await seedBlobless(local);

    // A tiny byte budget must not throttle rows that transfer no bytes —
    // otherwise a channel of captions would need one round per caption.
    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 1,
      maxItems: 1000,
    }).exchange();

    expect(result.shipped).toBe(50);
    expect(result.outboundHasMore).toBe(false);
  });

  it("uploads a file larger than any budget, and small files beside it", async () => {
    const { local, cloud } = await twoSides();
    const big = await seedBlobRecord(local, 400 * MB);
    const small: StarkeepId[] = [];
    for (let i = 0; i < 5; i += 1) small.push(await seedBlobRecord(local, 1 * MB));

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 10 * MB,
    });
    const result = await engine.exchange();
    await upload(local, engine);

    expect(result.shipped).toBe(6);
    expect(engine.uploader.stats().sent.count).toBe(6);
    for (const id of [big, ...small]) {
      expect(await cloud.storage.has((await local.db.get(id))!.objectStorageKey)).toBe(true);
    }
  });

  it("the item cap still binds when bytes do not", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 20; i += 1) await seedBlobless(local);

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
      maxItems: 7,
    }).exchange();

    expect(result.shipped).toBe(7);
    expect(result.outboundHasMore).toBe(true);
  });

  it("converges across rounds — nothing is stranded by the budget", async () => {
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await seedBlobRecord(local, 3 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 10 * MB });
    const result = await engine.sync({ maxRounds: 20 });
    await upload(local, engine);
    await engine.sync();

    expect(result.complete).toBe(true);
    for (const id of ids) {
      expect(await cloud.db.get(id), id).not.toBeNull();
      expect(await cloud.storage.has((await local.db.get(id))!.objectStorageKey), id).toBe(true);
    }
    // The peer's bytes watermark reached the last row: nothing is owed.
    const last = (await local.db.get(ids[11]!))!;
    expect((await syncState.getPeerByteWatermarks())?.["L"]).toEqual(last.updatedAt);
  });

  it("concurrent transfer still stops the peer's bytes watermark at an author's first failure", async () => {
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedBlobRecord(local, 1 * MB));

    // Fail the third file. Later files upload anyway — transfers overlap, and
    // the bytes are content-addressed — but the peer's bytes watermark must
    // not pass the failure, or that upload would never be owed again.
    const failing = (await local.db.get(ids[2]!))!.objectStorageKey;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (key: string, ...rest: unknown[]) => {
      if (key === failing) throw new Error("[test] injected upload failure");
      return (realPutStream as (...a: unknown[]) => Promise<void>)(key, ...rest);
    };

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, {
      maxBytes: 100 * MB,
      transferConcurrency: 4,
    });
    const result = await engine.exchange();
    await upload(local, engine);

    expect(result.shipped).toBe(5);
    expect(engine.uploader.stats().sent.count).toBe(4);
    expect(engine.uploader.stats().queued.full.count).toBe(1);
    for (const id of ids) expect(await cloud.db.get(id)).not.toBeNull();
    expect(await cloud.storage.has(failing)).toBe(false);

    await engine.exchange();
    const second = (await local.db.get(ids[1]!))!;
    expect((await syncState.getPeerByteWatermarks())?.["L"]).toEqual(second.updatedAt);
  });

  /**
   * Run `count` transfers of `sizeBytes` each and report the most ever in
   * flight at once, measured at the destination's `putStream`, which is where
   * a transfer occupies a connection. The short delay is what makes overlap
   * possible at all: without it each transfer completes inside its own
   * microtask and the peak is 1 no matter what the limit says.
   */
  async function peakInFlight(
    direction: "upload" | "download",
    count: number,
    sizeBytes: number,
    transferConcurrency?: number,
  ): Promise<{ peak: number; moved: number }> {
    const { local, cloud } = await twoSides();
    const source = direction === "upload" ? local : cloud;
    const destination = direction === "upload" ? cloud : local;
    for (let i = 0; i < count; i += 1) await seedBlobRecord(source, sizeBytes);

    let inFlight = 0;
    let peak = 0;
    let moved = 0;
    const realPutStream = destination.storage.putStream.bind(destination.storage);
    destination.storage.putStream = async (...args: unknown[]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await (realPutStream as (...a: unknown[]) => Promise<void>)(...args);
        moved += 1;
      } finally {
        inFlight -= 1;
      }
    };

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
      maxItems: count,
      ...(transferConcurrency !== undefined ? { transferConcurrency } : {}),
    });
    await engine.exchange();
    if (direction === "upload") await upload(local, engine);
    return { peak, moved };
  }

  it("never has more downloads in flight than transferConcurrency allows", async () => {
    // On a handset this is a phone opening eight transfers on a cellular link
    // because a round happened to be large.
    const { peak, moved } = await peakInFlight("download", 8, 1 * MB, 2);
    expect(moved).toBe(8);
    // …and it really did overlap, so the bound is what is holding it down.
    expect(peak).toBe(2);
  });

  it("serializes downloads at a limit of one", async () => {
    const { peak, moved } = await peakInFlight("download", 6, 1 * MB, 1);
    expect(moved).toBe(6);
    expect(peak).toBe(1);
  });

  it("uploads small files six at a time, in the small lane", async () => {
    const { peak, moved } = await peakInFlight("upload", 12, 512 * 1024);
    expect(moved).toBe(12);
    expect(peak).toBe(6);
  });

  it("uploads large files two at a time, in the large lane", async () => {
    const { peak, moved } = await peakInFlight("upload", 6, 4 * MB);
    expect(moved).toBe(6);
    expect(peak).toBe(2);
  });
});

/**
 * `sync()` — the loop, and the pull-before-push ordering inside it.
 *
 * `peerWatermarks` is a cache of what the peer last said about itself, and a
 * round whose response is lost leaves it stale-low. Pushing against a stale-low
 * cache re-ships items the peer already took. Round 0 therefore ships nothing:
 * it refreshes the cache and takes delivery of the inbound half, so every later
 * round decides against a map at most one round old.
 */
describe("sync()", () => {
  it("ships nothing in round 0 when there is a backlog, then pushes", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 3; i += 1) await seedBlobRecord(local, 1 * MB);

    const rounds: { shipped: number }[] = [];
    await engineFor(local, cloud, createMemorySyncStateStore(), { maxBytes: 100 * MB }).sync({
      onRound: (result) => rounds.push({ shipped: result.shipped }),
    });

    expect(rounds[0]!.shipped).toBe(0);
    expect(rounds.reduce((n, r) => n + r.shipped, 0)).toBe(3);
  });

  it("does not spend a pull-only round when nothing is owed", async () => {
    // Steady state is the quietest and most frequent case, and a pull-only
    // round followed by a pushing round would be two byte-identical requests.
    const { local, cloud } = await twoSides();

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
    }).sync();

    expect(result.rounds).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("does not re-ship after a lost response", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 3; i += 1) await seedBlobRecord(local, 1 * MB);

    // A round the peer applied but whose response never came back: the cloud
    // holds everything, the phone's peerWatermarks never advanced.
    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.exchange();
    await syncState.setPeerWatermarks({});

    // Round 0 adopts the cloud's real coverage, so the push that follows finds
    // nothing owed. Without pull-first this would re-ship all three.
    const shipped: number[] = [];
    await engine.sync({ onRound: (r) => shipped.push(r.shipped) });

    expect(shipped.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("reports complete when both directions drain", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 12; i += 1) await seedBlobRecord(local, 3 * MB);

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 10 * MB,
    }).sync();

    expect(result.complete).toBe(true);
    expect(result.rounds).toBeGreaterThan(1);
    expect(result.shipped).toBe(12);
  });

  it("stops on an abort signal, and the next call resumes", async () => {
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await seedBlobRecord(local, 3 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxItems: 3 });

    let aborted = false;
    const first = await engine.sync({
      signal: {
        get aborted() {
          return aborted;
        },
      },
      onRound: (_r, round) => {
        if (round >= 2) aborted = true;
      },
    });
    expect(first.complete).toBe(false);

    // Abandonment is free: each round persisted its own watermarks, so this
    // picks up rather than starting over.
    const second = await engine.sync();
    expect(second.complete).toBe(true);
    for (const id of ids) expect(await cloud.db.get(id), id).not.toBeNull();
  });

  it("honours maxRounds as a backstop", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 12; i += 1) await seedBlobRecord(local, 3 * MB);

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxItems: 3,
    }).sync({ maxRounds: 2 });

    expect(result.rounds).toBe(2);
    expect(result.complete).toBe(false);
  });

  it("says work remains rather than stuck when maxRounds runs out", async () => {
    // Test 22 — what the *caller* is supposed to conclude, which is the half
    // `honours maxRounds as a backstop` does not pin. The backstop and a stall
    // both end the loop with `complete: false`, and they mean opposite things:
    // one is "call again and it will finish", the other is "calling again will
    // achieve nothing". `stalled` is the only thing separating them, so a run
    // cut short by the budget must not set it — and the next call must finish.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await seedBlobRecord(local, 3 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxItems: 3 });

    const cut = await engine.sync({ maxRounds: 2 });
    expect(cut.complete).toBe(false);
    expect(cut.stalled, "the budget ran out; nothing is wedged").toBe(false);
    expect(cut.shipped).toBeGreaterThan(0);

    const finished = await engine.sync();
    expect(finished.complete).toBe(true);
    expect(finished.stalled).toBe(false);
    for (const id of ids) expect(await cloud.db.get(id), id).not.toBeNull();
  });
});

/**
 * `verify()` — the hole a coverage watermark cannot see.
 *
 * The contiguous-prefix rule stops a *sender* from leaving a gap below its
 * watermark. Nothing stops a *receiver* from developing one, and when it does,
 * `MAX(updated_at)` is unchanged — so the coverage report is unchanged, the
 * sender concludes all is well, and no number of sync rounds ever offers that
 * row again. These tests pin that the count comparison finds it and that the
 * repair rides the ordinary scan.
 */
describe("verify()", () => {
  /**
   * Drop a record straight out of the peer's store, leaving a hole.
   *
   * Reaches past the adapter deliberately: `delete()` writes a tombstone, which
   * is still a row and still syncs, so it is the opposite of the loss under
   * test. What is being simulated — a restore from an older backup, a
   * mis-scoped delete, a partial write — has no legitimate API by construction.
   */
  async function loseFromMiddle(cloud: Side, id: StarkeepId): Promise<void> {
    const store = (cloud.db as unknown as { store: Map<string, unknown> }).store;
    store.delete(id);
  }

  it("reports agreement when both sides hold the same rows", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 6; i += 1) await seedBlobRecord(local, 1 * MB);
    const engine = engineFor(local, cloud, createMemorySyncStateStore(), { maxBytes: 100 * MB });
    await engine.sync();

    const result = await engine.verify();
    expect(result.supported).toBe(true);
    expect(result.divergentBuckets).toBe(0);
    expect(result.localRows).toBe(result.peerRows);
  });

  it("detects a row lost from the middle, which the watermark cannot", async () => {
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await seedBlobRecord(local, 1 * MB));
    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();

    // Lose one from the middle, keeping a later one. MAX(updated_at) does not
    // move, so the coverage report is unchanged — this is exactly the loss the
    // protocol is blind to.
    await loseFromMiddle(cloud, ids[2]!);
    const watermarksAfterLoss = await cloud.db.getNodeWatermarks();
    expect(watermarksAfterLoss["L"]).toBeDefined();

    // A plain sync cannot see it.
    const blind = await engine.sync();
    expect(blind.shipped).toBe(0);
    expect(await cloud.db.get(ids[2]!)).toBeNull();

    // The count comparison can.
    const result = await engine.verify();
    expect(result.divergentBuckets).toBeGreaterThan(0);
    expect(result.peerRows).toBe(result.localRows - 1);
  });

  it("repairs the loss on the next sync, through the ordinary scan", async () => {
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await seedBlobRecord(local, 1 * MB));
    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();

    await loseFromMiddle(cloud, ids[2]!);
    await engine.verify();

    // verify() only arms the repair; sync() carries it out by re-shipping from
    // the lowered bound. Everything the peer still holds is an LWW no-op.
    await engine.sync();
    expect(await cloud.db.get(ids[2]!)).not.toBeNull();

    const after = await engine.verify();
    expect(after.divergentBuckets).toBe(0);
  });

  it("retires the repair floor once the peer catches up", async () => {
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await seedBlobRecord(local, 1 * MB));
    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await syncAndUpload(local, engine);

    await loseFromMiddle(cloud, ids[2]!);
    await engine.verify();
    expect(Object.keys(await syncState.getRepairFloors())).toHaveLength(1);

    await engine.sync();

    // Holding the floor any longer would re-ship the same range every round
    // forever, since the floor is what pulls the scan's bound back down.
    expect(await syncState.getRepairFloors()).toEqual({});
    const quiet = await engine.sync();
    expect(quiet.shipped).toBe(0);
  });

  it("converges when the peer holds an older version of a row we hold newer", async () => {
    // The case counts-not-checksums rests on, and until now only prose. The
    // peer's copy is not *missing*, it is stale — so its `updated_at` lands in
    // an earlier bucket than ours. Both buckets therefore disagree: ours has a
    // row the peer's does not, and the peer's has one ours does not. Only the
    // first is a repair trigger, and the floor it arms sits below the newer
    // row, so the ordinary scan re-ships it and LWW settles the rest.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await seedBlobRecord(local, 1 * MB));
    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();

    // Update one record locally, far enough ahead to land in another bucket,
    // and leave the peer on its old copy — a round that never arrived.
    const stale = (await cloud.db.get(ids[1]!))!;
    const fresh = {
      ...(await local.db.get(ids[1]!))!,
      updatedAt: { wallTime: 2_000_000_000_000, counter: 0, nodeId: "L" },
    };
    await local.db.put(fresh);
    (cloud.db as unknown as { store: Map<string, unknown> }).store.set(ids[1]!, stale);
    await syncState.setPeerWatermarks(await cloud.db.getNodeWatermarks());

    // Row counts match — the peer is not missing anything — but the buckets do
    // not, because the same row is filed under two different times. Reported as
    // pending rather than as loss, which is the correct reading: the newer copy
    // is sitting in our own outbound queue.
    const seen = await engine.verify();
    expect(seen.localRows).toBe(seen.peerRows);
    expect(seen.pendingUpload).toBeGreaterThan(0);
    expect(seen.divergentBuckets).toBe(0);

    await engine.sync();

    expect((await cloud.db.get(ids[1]!))!.updatedAt).toEqual(fresh.updatedAt);
    const after = await engine.verify();
    expect(after.divergentBuckets).toBe(0);
    expect(after.missingLocally).toBe(0);
  });
});

/**
 * Termination — the loop's other exit.
 *
 * `hasMore` and `outboundHasMore` are predictions ("there is more owed"), and
 * neither is monotone under failure. A blob that will never upload is swallowed
 * into a contiguous-prefix truncation *by design* — the rule needs it swallowed,
 * so it is not an error at this layer and nothing throws — which leaves a round
 * that scans a backlog, ships nothing, and truthfully reports more owed.
 * Forever. Before the loop existed the poll interval bounded that to one retry
 * per tick; adding the loop removed the bound.
 */
describe("records sharing one object key", () => {
  /** Two distinct records whose bytes are identical, so they name one object. */
  async function seedSharingKey(side: Side, key: string): Promise<StarkeepId> {
    const id = generateId() as StarkeepId;
    await side.storage.put(key, new Uint8Array(8));
    await side.db.put({
      ...createDataRecord(
        {
          type: "image/jpeg",
          originAppId: "photos",
          contentHash: "sha256:identical-bytes",
          objectStorageKey: key,
          mimeType: "image/jpeg",
          sizeBytes: 8,
        },
        side.clock,
      ),
      id,
    });
    return id;
  }

  it("ships both in one round rather than treating the second as a failure", async () => {
    // Record blobs are content-addressed, so identical bytes mean an identical
    // key. Dispatched as two transfers, the second met the first in flight and
    // `transferFile` answered false — indistinguishable from a failed upload,
    // so the author's shipment stopped at it and the round reported itself
    // complete with a record left behind.
    const { local, cloud } = await twoSides();
    const key = "apps/photos/syncable/identical-bytes.bin";
    const first = await seedSharingKey(local, key);
    const second = await seedSharingKey(local, key);

    const result = await engineFor(local, cloud, createMemorySyncStateStore()).sync();

    expect(await cloud.db.get(first)).not.toBeNull();
    expect(await cloud.db.get(second)).not.toBeNull();
    expect(result.complete).toBe(true);
    expect(result.stalled).toBe(false);
  });

  it("sends the shared bytes once, not once per record", async () => {
    const { local, cloud } = await twoSides();
    const key = "apps/photos/syncable/identical-bytes.bin";
    await seedSharingKey(local, key);
    await seedSharingKey(local, key);
    await seedSharingKey(local, key);

    let puts = 0;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (...args: Parameters<typeof realPutStream>) => {
      puts += 1;
      return realPutStream(...args);
    };

    // The queue keys on the object key, so three rows are one entry.
    const engine = engineFor(local, cloud, createMemorySyncStateStore());
    await syncAndUpload(local, engine);
    expect(puts).toBe(1);
  });

  it("still fails every record naming a key whose transfer failed", async () => {
    // The flip side of sharing an outcome: one failure has to reach all of
    // them, or the peer's bytes watermark passes a file that never arrived.
    const { local, cloud } = await twoSides();
    const key = "apps/photos/syncable/identical-bytes.bin";
    const first = await seedSharingKey(local, key);
    const second = await seedSharingKey(local, key);
    cloud.storage.putStream = async () => {
      throw new Error("[test] permanent upload failure");
    };

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState);
    await syncAndUpload(local, engine);

    // Both rows ship; neither one's file is counted as held, and the one
    // entry both name stays queued.
    expect(await cloud.db.get(first)).not.toBeNull();
    expect(await cloud.db.get(second)).not.toBeNull();
    expect(await cloud.storage.has(key)).toBe(false);
    expect((await syncState.getPeerByteWatermarks())?.["L"]).toBeUndefined();
    expect(engine.uploader.stats().queued.full.count).toBe(1);
  });

  it("two channels naming the same key each send it, and both succeed", async () => {
    // Test 21 — stated rather than fixed. Sharing an outcome is per *engine*:
    // each `createSyncEngine` builds its own file-sync engine and therefore its
    // own in-flight table, so the Drive channel and a per-app channel both
    // upload a content-addressed key they happen to share.
    //
    // That is a duplicate PUT of identical bytes to a key that already names
    // them, which costs bandwidth and nothing else — the object is the same
    // object, and the destination's `has()` short-circuit means the second
    // transfer usually finds it already there. Coordinating across engines would
    // mean a shared mutable table between two channels that otherwise touch
    // nothing in common, which is a worse trade. Written down so the next reader
    // knows it was weighed rather than missed.
    const { local, cloud } = await twoSides();
    const key = "apps/photos/syncable/identical-bytes.bin";
    const id = await seedSharingKey(local, key);

    const a = engineFor(local, cloud, createMemorySyncStateStore());
    const b = engineFor(local, cloud, createMemorySyncStateStore());

    let puts = 0;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (...args: Parameters<typeof realPutStream>) => {
      puts += 1;
      // Yield, so the two engines genuinely overlap rather than running in turn.
      await new Promise((r) => setTimeout(r, 5));
      return realPutStream(...args);
    };

    const [first, second] = await Promise.all([a.sync(), b.sync()]);
    await Promise.all([a.uploader.drain(), b.uploader.drain()]);

    expect(first.complete && second.complete, "neither may read the other as a failure").toBe(true);
    expect(a.uploader.stats().sent.count + b.uploader.stats().sent.count).toBe(2);
    expect(await cloud.db.get(id)).not.toBeNull();
    expect(await cloud.storage.has(key)).toBe(true);
    expect(puts, "each engine sends it once; nothing coordinates across them").toBe(2);
  });
});

describe("the responder's half of the byte budget", () => {
  /**
   * Rows travel ahead of their files, so the responder charges no row for its
   * file. The caller budgets its downloads itself, in its download pass. A
   * responder that charged rows would put back exactly the wait this design
   * removes: a desktop pulling a phone's round would get eight rows instead of
   * a thousand because the eight named originals.
   */
  function responderFor(cloud: Side) {
    return createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
  }

  it("ships rows without charging their files against the caller's budget", async () => {
    const { cloud } = await twoSides();
    for (let i = 0; i < 6; i += 1) await seedBlobRecord(cloud, 3 * MB);

    const response = await responderFor(cloud).exchange({
      watermarks: {},
      limit: 1000,
      maxBytes: 1 * MB,
    });

    expect(response.records).toHaveLength(6);
    expect(response.hasMore).toBe(false);
  });

  it("still bounds rows by the caller's item cap", async () => {
    const { cloud } = await twoSides();
    for (let i = 0; i < 6; i += 1) await seedBlobless(cloud);

    const response = await responderFor(cloud).exchange({
      watermarks: {},
      limit: 4,
      maxBytes: 1,
    });

    expect(response.records).toHaveLength(4);
    expect(response.hasMore).toBe(true);
  });

  it("reports its bytes watermark with every response", async () => {
    const { cloud } = await twoSides();
    const id = await seedBlobRecord(cloud, 1 * MB);

    const response = await responderFor(cloud).exchange({ watermarks: {}, limit: 1000 });

    // The file is in the responder's storage, so the watermark covers its row.
    expect(response.responderByteWatermarks?.["C"]).toEqual((await cloud.db.get(id))!.updatedAt);
  });
});

describe("sync() termination", () => {
  it("does not hold a sync open over a file whose upload keeps failing", async () => {
    // Uploads left the round, so a failing one can neither loop `sync()` nor
    // keep it from finishing. The file waits in the uploader's queue, and the
    // files behind it go.
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 5; i += 1) await seedBlobRecord(local, 3 * MB);

    const oldest = (await local.db.query({})).records.sort(
      (a, b) => a.updatedAt.wallTime - b.updatedAt.wallTime,
    )[0]!;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (key: string, ...rest: unknown[]) => {
      if (key === oldest.objectStorageKey) throw new Error("[test] permanent upload failure");
      return (realPutStream as (...a: unknown[]) => Promise<void>)(key, ...rest);
    };

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 4 * MB,
      maxItems: 100,
    });
    const result = await engine.sync({ maxRounds: 500 });
    await upload(local, engine);

    expect(result.rounds).toBeLessThan(4);
    expect(result.shipped).toBe(5);
    expect(result.complete).toBe(true);
    for (const record of (await local.db.query({})).records) {
      if (record.id === oldest.id) continue;
      expect(await cloud.storage.has(record.objectStorageKey)).toBe(true);
    }
    // The stuck file is not lost: the queue holds it for its next attempt.
    expect(engine.uploader.stats().queued.full.count).toBe(1);
    expect(engine.uploader.stats().sent.count).toBe(4);
  });

  it("keeps a file whose upload keeps failing in the queue, where the uploader reports it", async () => {
    // The honest "backup not finished" now comes from the uploader: the round
    // drained, and the file is still owed.
    const { local, cloud } = await twoSides();
    const id = await seedBlobRecord(local, 1 * MB);
    const record = (await local.db.get(id))!;
    cloud.storage.putStream = async () => {
      throw new Error("[test] permanent upload failure");
    };

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
    });
    const result = await engine.sync();
    await engine.uploader.drain();

    expect(result.shipped).toBe(1);
    expect(await cloud.db.get(id)).not.toBeNull();
    expect(await cloud.storage.has(record.objectStorageKey)).toBe(false);
    const stats = engine.uploader.stats();
    expect(stats.queued.full.count).toBe(1);
    expect(stats.backingOff).toBe(1);
  });

  it("does not report complete when an inbound blob keeps failing", async () => {
    // The mirror. The responder has nothing further to send, so `hasMore` is
    // false, but our own watermark cannot advance past a blob that will not
    // download — so the round left something behind and the sync is not done.
    const { local, cloud } = await twoSides();
    const id = await seedBlobRecord(cloud, 1 * MB);
    local.storage.putStream = async () => {
      throw new Error("[test] permanent download failure");
    };

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
    }).sync();

    expect(await local.storage.has((await cloud.db.get(id))!.objectStorageKey)).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.stalled).toBe(true);
  });

  it("does not call an ordinary drained sync stalled", async () => {
    // The guard must not fire on the quiet case, or every steady-state sync
    // would report itself wedged.
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 4; i += 1) await seedBlobRecord(local, 1 * MB);

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
    }).sync();

    expect(result.complete).toBe(true);
    expect(result.stalled).toBe(false);
  });

  it("resumes and finishes once the failing upload starts working", async () => {
    // A failure is not a terminal state: the entry backs off and is tried
    // again, and the cloud's bytes watermark then passes it.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedBlobRecord(local, 3 * MB));

    const oldest = (await local.db.get(ids[0]!))!;
    let failing = true;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (key: string, ...rest: unknown[]) => {
      if (failing && key === oldest.objectStorageKey) throw new Error("[test] transient");
      return (realPutStream as (...a: unknown[]) => Promise<void>)(key, ...rest);
    };

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 4 * MB });
    await syncAndUpload(local, engine);
    expect(await cloud.storage.has(oldest.objectStorageKey)).toBe(false);

    failing = false;
    await upload(local, engine);
    const recovered = await engine.sync();
    expect(recovered.complete).toBe(true);
    for (const id of ids) expect(await cloud.db.get(id), id).not.toBeNull();
    const last = (await local.db.get(ids[4]!))!;
    expect((await syncState.getPeerByteWatermarks())?.["L"]).toEqual(last.updatedAt);
  });
});

/**
 * Repair floors — armed by evidence, and retired only by evidence.
 *
 * A floor is the *only* remaining record that a hole under the peer's watermark
 * still needs filling: the peer's own coverage report sits above the hole by
 * construction, so once the floor is gone nothing will ever ask again. Retiring
 * it therefore has to mean "the re-ship actually happened", not "a round went
 * by looking successful".
 */
describe("repair floor retirement", () => {
  /**
   * Lose a record from the peer entirely — row and bytes.
   *
   * The bytes matter here: `transferFile` short-circuits when the destination
   * already holds the key, so leaving the blob behind would let the repair
   * succeed without ever attempting an upload, and the failure under test could
   * not happen.
   */
  async function loseFromMiddle(cloud: Side, id: StarkeepId): Promise<void> {
    const record = await cloud.db.get(id);
    const store = (cloud.db as unknown as { store: Map<string, unknown> }).store;
    store.delete(id);
    if (record?.objectStorageKey) await cloud.storage.delete(record.objectStorageKey);
  }

  // Explicitly timed out, generously. These two seed several megabytes of real
  // bytes and hash every one of them through the transfer path — they sit
  // around two seconds on an idle machine and several times that when the
  // workspace's other suites are running beside them, which is exactly when a
  // 5-second default bites. A slow test is not a failing one, and a flake here
  // reads as a sync regression.
  it(
    "keeps a repaired file queued when its upload fails, though the floor retires",
    { timeout: 30_000 },
    async () => {
      const { local, cloud } = await twoSides();
      const ids: StarkeepId[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await seedBlobRecord(local, 1 * MB));

      const syncState = createMemorySyncStateStore();
      const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
      await syncAndUpload(local, engine);

      // A hole in the middle, row and file: MAX(updated_at) is unchanged, so
      // neither watermark the cloud reports moves, and only a count
      // comparison can see it.
      await loseFromMiddle(cloud, ids[2]!);
      await engine.verify();
      expect(Object.keys(await syncState.getRepairFloors())).toHaveLength(1);

      // The row re-ships, and the file's upload fails. The floor retires with
      // its rows: the uploader saw the floor lower the cloud's watermark, read
      // the range again, and holds the file in its own queue.
      const lost = ids[2]!;
      const lostKey = (await local.db.get(lost))!.objectStorageKey;
      const realPutStream = cloud.storage.putStream.bind(cloud.storage);
      cloud.storage.putStream = async (key: string, ...rest: unknown[]) => {
        if (key === lostKey) throw new Error("[test] upload failure during repair");
        return (realPutStream as (...a: unknown[]) => Promise<void>)(key, ...rest);
      };
      await engine.sync();
      await upload(local, engine);

      expect(await cloud.db.get(lost)).not.toBeNull();
      expect(await cloud.storage.has(lostKey)).toBe(false);
      expect(await syncState.getRepairFloors()).toEqual({});
      expect(engine.uploader.stats().queued.full.count, "the queue still owes the file").toBe(1);

      // When the transfer recovers, the queue completes the job.
      cloud.storage.putStream = realPutStream as typeof cloud.storage.putStream;
      await upload(local, engine);
      expect(await cloud.storage.has(lostKey)).toBe(true);
    },
  );

  it("re-sends a file the peer lost along with its row", { timeout: 30_000 }, async () => {
    // The cloud's bytes watermark sits above a hole exactly as its rows
    // watermark does. Without the floor lowering the watermark the uploader
    // reads, the repair would put the row back and leave its file missing.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await seedBlobRecord(local, 1 * MB));
    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await syncAndUpload(local, engine);

    const lostKey = (await local.db.get(ids[1]!))!.objectStorageKey;
    await loseFromMiddle(cloud, ids[1]!);
    await engine.verify();
    await syncAndUpload(local, engine);

    expect(await cloud.db.get(ids[1]!)).not.toBeNull();
    expect(await cloud.storage.has(lostKey)).toBe(true);
    expect(await syncState.getRepairFloors()).toEqual({});
  });

  it("advances the floor so a repair wider than one round still finishes", async () => {
    // The floor is the bound the scan takes, so a floor that never moves makes
    // every round select the same rows from the same place, cut them at the
    // same budget, and ship the same prefix forever. Nothing retires it,
    // because retirement waits on a drain that cannot happen.
    //
    // Six records against a two-item budget: the repair needs three rounds, so
    // it is exactly the case a fixed mark cannot express.
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 6; i += 1) await seedAuthored(local, "aaa", 10 + i);

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxItems: 2 });
    await syncAndUpload(local, engine);

    // Arm a repair spanning the author's whole history, the widest a floor gets.
    await syncState.setRepairFloors({ aaa: { wallTime: 0, counter: 0, nodeId: "aaa" } });

    const result = await engine.sync({ maxRounds: 20 });

    expect(result.complete, "the repair drained").toBe(true);
    expect(result.stalled).toBe(false);
    expect(await syncState.getRepairFloors(), "the floor retired once drained").toEqual({});
    // One pass over the range, not one pass per round. Six rows at two per
    // round is three shipping rounds; a fixed mark would have re-shipped the
    // same two rows for all twenty.
    expect(result.shipped).toBeLessThanOrEqual(8);
  });

  it("holds a floor while the peer's bytes watermark is below it", async () => {
    // The files half of a repair waits only on the watermark the round saves.
    // A floor above a file the cloud still lacks stays, so the watermark the
    // uploader reads stays lowered until that file lands.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await seedAuthored(local, "aaa", 10 + i));
    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    // Rows only: no file has reached the cloud, so its bytes watermark for
    // `aaa` is below every row.
    await engine.sync();
    const floor = { wallTime: 11, counter: 0, nodeId: "aaa" };
    await syncState.setRepairFloors({ aaa: floor });

    await engine.sync();
    expect(await syncState.getRepairFloors()).toEqual({ aaa: floor });

    await syncAndUpload(local, engine);
    expect(await syncState.getRepairFloors()).toEqual({});
  });
});

/**
 * `verify()` answers two questions, not one.
 *
 * The count comparison that finds a hole on the peer is deliberately
 * one-directional — a bucket where the peer has *more* is ordinary data we have
 * not pulled yet, not corruption. But "is my library backed up?" is the mirror
 * question, and answering it with the repair trigger reports a clean bill of
 * health to a node that is itself missing rows.
 */
describe("verify() — both directions", () => {
  async function loseFromMiddle(side: Side, id: StarkeepId): Promise<void> {
    const store = (side.db as unknown as { store: Map<string, unknown> }).store;
    store.delete(id);
  }

  it("sees a hole on our own side, which the repair trigger cannot", async () => {
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedBlobRecord(cloud, 1 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();

    await loseFromMiddle(local, ids[2]!);

    const result = await engine.verify();
    // The peer is not missing anything, so the outbound trigger is silent —
    // correctly. The inbound question is the one with an answer here.
    expect(result.divergentBuckets).toBe(0);
    expect(result.missingLocally).toBeGreaterThan(0);
    expect(result.localRows).toBe(result.peerRows - 1);
  });

  it("repairs our own hole by advertising less than we hold", async () => {
    // Our watermark is MAX(updated_at), so a loss underneath it does not move
    // it and the peer goes on believing we have the row. The only lever is the
    // number we advertise, since that is what the responder scans above.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedBlobRecord(cloud, 1 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();
    await loseFromMiddle(local, ids[2]!);

    // A plain sync is blind to it: our watermark never moved.
    await engine.sync();
    expect(await local.db.get(ids[2]!)).toBeNull();

    await engine.verify();
    expect(Object.keys(await syncState.getInboundFloors())).toHaveLength(1);
    await engine.sync();

    expect(await local.db.get(ids[2]!)).not.toBeNull();
    expect(await syncState.getInboundFloors()).toEqual({});
    expect((await engine.verify()).missingLocally).toBe(0);
  });

  it("repairs a hole that takes several rounds to re-receive", async () => {
    // The floor has to act as a *cursor*, not a fixed mark. It is what we
    // advertise, and what we advertise is what the peer scans above — and our
    // own watermark cannot move it along, because it already sits above the
    // hole (that is what made the hole invisible). A floor that stays put asks
    // for the same range every round and never gets past its first roundful.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await seedBlobRecord(cloud, 1 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();

    // Lose one early row, so the repair range spans far more than one round.
    await loseFromMiddle(local, ids[1]!);
    await engine.verify();
    expect(Object.keys(await syncState.getInboundFloors())).toHaveLength(1);

    // A budget of two items per round: the range from the floor upward needs
    // several rounds, and a round that only re-receives rows already present
    // applies nothing — so it must still count as progress or the loop gives up.
    const paced = engineFor(local, cloud, syncState, { maxBytes: 100 * MB, maxItems: 2 });
    const result = await paced.sync();

    expect(await local.db.get(ids[1]!), "the lost row must come back").not.toBeNull();
    expect(result.stalled, "a repair in progress is not a stall").toBe(false);
    expect(await syncState.getInboundFloors()).toEqual({});
  });

  it("refuses to compare digests bucketed at different widths", async () => {
    // Two peers bucketing differently would find *every* bucket disagreeing and
    // re-ship the whole library as a "repair". Reporting "not verified" is the
    // only safe answer, and it needs the width on the wire to notice at all.
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 3; i += 1) await seedBlobRecord(local, 1 * MB);

    const syncState = createMemorySyncStateStore();
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      // A peer that answers at a width nobody asked for.
      transport: {
        async exchange(request) {
          const response = await transport.exchange(request);
          if (!response.digest) return response;
          return { ...response, digestPrefixLength: 3 };
        },
      },
      clock: local.clock,
      syncState,
      syncSharedRecords: true,
    });
    await engine.sync();

    const result = await engine.verify();
    expect(result.supported).toBe(false);
    expect(result.divergentBuckets).toBe(0);
    expect(await syncState.getRepairFloors()).toEqual({});
  });

  it("reports a pull backlog as pending, not as a hole", async () => {
    // The mirror comparison flags every bucket where the peer holds more than
    // we do — which is exactly what a phone mid-first-sync looks like. Counting
    // that as loss puts "this phone is missing rows in N time ranges" on the
    // screen for a node that is merely behind, and arms an inbound repair over
    // a backlog the next ordinary round was already going to deliver.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedBlobRecord(cloud, 1 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });

    const result = await engine.verify();
    expect(result.supported).toBe(true);
    expect(result.missingLocally, "behind is not missing").toBe(0);
    expect(result.pendingDownload).toBeGreaterThan(0);
    expect(await syncState.getInboundFloors(), "no repair for a queue").toEqual({});

    // Drained, the same comparison is a hole again — nothing here is masked.
    await engine.sync();
    await loseFromMiddle(local, ids[2]!);
    const after = await engine.verify();
    expect(after.missingLocally).toBeGreaterThan(0);
    expect(after.pendingDownload).toBe(0);
  });

  it("reports a push backlog as pending, not as the peer's loss", async () => {
    // Same argument from the other end: rows we have not shipped yet are not
    // rows the peer lost, and arming an outbound repair over them re-scans from
    // a floor the ordinary round already covers.
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 5; i += 1) await seedBlobRecord(local, 1 * MB);

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });

    const result = await engine.verify();
    expect(result.supported).toBe(true);
    expect(result.divergentBuckets).toBe(0);
    expect(result.pendingUpload).toBeGreaterThan(0);
    expect(await syncState.getRepairFloors()).toEqual({});
  });

  it("refuses to compare digests built over different table sets", async () => {
    // Both sides sum their *own* tables into shared buckets, so an app upgraded
    // on one end makes every bucket disagree in both directions over a schema
    // difference — reported as catastrophic divergence and repaired by
    // re-shipping the library twice.
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 3; i += 1) await seedBlobRecord(local, 1 * MB);

    const syncState = createMemorySyncStateStore();
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      // A peer that counted one table more than we did.
      transport: {
        async exchange(request) {
          const response = await transport.exchange(request);
          if (!response.digest) return response;
          return {
            ...response,
            digestScopes: [...(response.digestScopes ?? []), "photos.file_records"],
          };
        },
      },
      clock: local.clock,
      syncState,
      syncSharedRecords: true,
    });
    await engine.sync();

    const result = await engine.verify();
    expect(result.supported).toBe(false);
    expect(result.divergentBuckets).toBe(0);
    expect(result.missingLocally).toBe(0);
    expect(await syncState.getRepairFloors()).toEqual({});
    expect(await syncState.getInboundFloors()).toEqual({});
  });

  it("reports unsupported when the local digest could not be counted", async () => {
    // A table we could not count is not a table we hold nothing in. Reading the
    // uncounted rows as rows we are missing is the loud failure mode from a
    // quiet one — a full-library inbound repair off a read error.
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 3; i += 1) await seedBlobRecord(cloud, 1 * MB);

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();

    local.db.bucketDigest = async () => {
      throw new Error("[test] digest read failure");
    };

    const result = await engine.verify();
    expect(result.supported).toBe(false);
    expect(result.missingLocally).toBe(0);
    expect(await syncState.getInboundFloors()).toEqual({});
  });

  it("does not lower a climbed inbound cursor when verify() runs mid-repair", async () => {
    // The inbound floor is a *cursor*: the exchange loop raises it to wherever
    // each round's contiguous run reached. `applyRepairFloors` takes the lower
    // of two values — right for lowering a coverage watermark, wrong for
    // merging into a cursor — so a verify() during a repair used to put the
    // cursor back at the bottom of the range it had been climbing out of.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await seedBlobRecord(cloud, 1 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();
    await loseFromMiddle(local, ids[1]!);
    await engine.verify();

    // One paced round, so the cursor climbs but the repair is not finished.
    const paced = engineFor(local, cloud, syncState, { maxBytes: 100 * MB, maxItems: 2 });
    await paced.exchange();
    const climbed = (await syncState.getInboundFloors())["C"];
    expect(climbed, "the round should have moved the cursor").toBeDefined();

    await engine.verify();

    const after = (await syncState.getInboundFloors())["C"];
    expect(after).toBeDefined();
    expect(
      compareHLC(after!, climbed!),
      "verify() must not put the cursor back below where the repair reached",
    ).toBeGreaterThanOrEqual(0);
  });

  it("lets a multi-round repair finish even when verify() is pressed twice", async () => {
    // Test 12, and the user-visible version of the case above: pressing "Check
    // backup" during a long repair used to reset it, so a repair paced across
    // several rounds never converged while anyone kept checking on it.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await seedBlobRecord(cloud, 1 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();
    await loseFromMiddle(local, ids[1]!);

    await engine.verify();
    await engine.verify();

    const paced = engineFor(local, cloud, syncState, { maxBytes: 100 * MB, maxItems: 2 });
    for (let i = 0; i < 3; i += 1) {
      await paced.exchange();
      await engine.verify();
    }
    const result = await paced.sync();

    expect(await local.db.get(ids[1]!), "the lost row must come back").not.toBeNull();
    expect(result.stalled).toBe(false);
    expect(await syncState.getInboundFloors()).toEqual({});
  });

  it("delays a second, lower hole found mid-repair rather than losing it", async () => {
    // The cost side of `raiseInboundFloors`, made explicit. Keeping the higher
    // of two floors is what stops a verify() from resetting a climbing cursor —
    // but the same rule discards a *genuinely new* hole discovered below where
    // the cursor has already reached. Round 3 asks for that trade to be shown
    // to be a delay rather than a loss, since a repair that quietly skips a row
    // and then retires its floor would leave the row gone with every signal
    // reading clean.
    //
    // Two mechanisms conspire to defer it and neither one drops it: verify()
    // advertises the floored map, so mid-repair it reports a pull backlog
    // instead of loss and arms nothing; and when it does arm, the fresh floor
    // loses to the climbed one. The repair above finishes, the floor retires,
    // and the next check finds the lower hole with nothing in its way.
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await seedBlobRecord(cloud, 1 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();

    // Hole one, high in the range, so its repair takes several rounds to reach.
    await loseFromMiddle(local, ids[9]!);
    await engine.verify();
    expect(Object.keys(await syncState.getInboundFloors())).toHaveLength(1);

    // Climb the cursor past the position hole two is about to open at.
    const paced = engineFor(local, cloud, syncState, { maxBytes: 100 * MB, maxItems: 2 });
    await paced.exchange();
    await paced.exchange();
    const climbed = (await syncState.getInboundFloors())["C"];
    expect(climbed, "the repair should have moved the cursor").toBeDefined();
    expect(
      compareHLC(climbed!, (await cloud.db.get(ids[1]!))!.updatedAt),
      "the cursor must be above hole two for this to be the case under test",
    ).toBeGreaterThan(0);

    // Hole two, below the cursor. Nothing the peer ships from here on covers it.
    await loseFromMiddle(local, ids[1]!);

    const midRepair = await engine.verify();
    expect(
      (await syncState.getInboundFloors())["C"],
      "the new hole must not drag the cursor back down",
    ).toEqual(climbed);
    // And it is reported as work in progress rather than as loss, because the
    // floored advertisement makes the peer's backlog visible as a backlog.
    expect(midRepair.missingLocally).toBe(0);
    expect(midRepair.pendingDownload).toBeGreaterThan(0);

    // The first repair runs to completion and retires its floor — while the
    // second hole is still open. This is the moment the trade costs something.
    const first = await paced.sync();
    expect(first.stalled).toBe(false);
    expect(await local.db.get(ids[9]!), "hole one is repaired").not.toBeNull();
    expect(await syncState.getInboundFloors()).toEqual({});
    expect(await local.db.get(ids[1]!), "hole two is still open — the delay").toBeNull();

    // …and the delay is all it is. With nothing outstanding, the next check
    // sees the lower hole, arms it, and the ordinary scan fills it.
    const found = await engine.verify();
    expect(found.missingLocally).toBeGreaterThan(0);
    expect(Object.keys(await syncState.getInboundFloors())).toHaveLength(1);

    const second = await paced.sync();
    expect(await local.db.get(ids[1]!), "hole two is repaired too").not.toBeNull();
    expect(second.stalled).toBe(false);
    expect(await syncState.getInboundFloors()).toEqual({});
    expect((await engine.verify()).missingLocally).toBe(0);
  });

  it("reports unsupported for a peer that cannot answer at all", async () => {
    const { local, cloud } = await twoSides();
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport: {
        async exchange(request) {
          const { digest: _d, digestPrefixLength: _p, ...rest } = await transport.exchange(request);
          return rest;
        },
      },
      clock: local.clock,
      syncState: createMemorySyncStateStore(),
      syncSharedRecords: true,
    });

    expect((await engine.verify()).supported).toBe(false);
  });
});
