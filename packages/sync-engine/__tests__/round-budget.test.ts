/**
 * Round sizing: the byte budget, the item cap, and concurrent blob transfer.
 *
 * The round is the unit of lost work — a dropped response costs one round's
 * re-scan and re-upload — so on a channel carrying files the thing worth
 * bounding is bytes, not row count. Six photos is ~18 MB; six labels is
 * nothing. These tests pin the three consequences of that choice:
 *
 *   1. Bytes bound a blob round, and blob-less rows spend none of the budget.
 *   2. An item larger than the whole budget still ships, alone — otherwise a
 *      single large video stalls its channel permanently.
 *   3. Transferring concurrently does not weaken the contiguous-prefix rule:
 *      what ships is still decided per author in HLC order, stopping at that
 *      author's first failure.
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
import type { SyncStateStore, Watermarks } from "../src/types.js";


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
    ...opts,
  });
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
async function seedAuthored(
  side: Side,
  nodeId: string,
  wallTime: number,
): Promise<StarkeepId> {
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
  it("bounds a blob round by bytes, not by item count", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 10; i += 1) await seedBlobRecord(local, 3 * MB);

    // 10 MB of budget against 3 MB items: three fit, the fourth does not.
    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 10 * MB,
      maxItems: 1000,
    }).exchange();

    expect(result.shipped).toBe(3);
    expect(result.outboundHasMore).toBe(true);
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

  it("still ships a single item larger than the whole budget", async () => {
    const { local, cloud } = await twoSides();
    await seedBlobRecord(local, 400 * MB);

    // Refusing it would stall the channel forever rather than making one
    // round big, so the first item is always taken.
    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 10 * MB,
    }).exchange();

    expect(result.shipped).toBe(1);
  });

  it("an oversized item does not drag the rest of the round along with it", async () => {
    const { local, cloud } = await twoSides();
    await seedBlobRecord(local, 400 * MB);
    for (let i = 0; i < 5; i += 1) await seedBlobRecord(local, 1 * MB);

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 10 * MB,
    }).exchange();

    expect(result.shipped).toBe(1);
    expect(result.outboundHasMore).toBe(true);
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
    for (let round = 0; round < 10; round += 1) {
      const result = await engine.exchange();
      if (!result.outboundHasMore) break;
    }

    for (const id of ids) {
      expect(await cloud.db.get(id), id).not.toBeNull();
    }
  });

  it("concurrent transfer still truncates an author at its first failure", async () => {
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedBlobRecord(local, 1 * MB));

    // Fail the third blob. Later blobs may well have uploaded already —
    // transfers overlap — but the *shipping* decision is made afterwards in
    // HLC order, so nothing past the failure may reach the peer. Otherwise the
    // peer's coverage watermark would leapfrog the failed record and it would
    // never be offered again.
    const failing = (await local.db.get(ids[2]!))!.objectStorageKey;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (key: string, ...rest: unknown[]) => {
      if (key === failing) throw new Error("[test] injected upload failure");
      return (realPutStream as (...a: unknown[]) => Promise<void>)(key, ...rest);
    };

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
      transferConcurrency: 4,
    }).exchange();

    expect(result.shipped).toBe(2);
    expect(await cloud.db.get(ids[0]!)).not.toBeNull();
    expect(await cloud.db.get(ids[1]!)).not.toBeNull();
    expect(await cloud.db.get(ids[2]!)).toBeNull();
    expect(await cloud.db.get(ids[3]!)).toBeNull();
    expect(await cloud.db.get(ids[4]!)).toBeNull();
  });

  /**
   * Ship `count` blobs with `transferConcurrency: limit` and report the most
   * uploads ever in flight at once.
   *
   * Measured at the destination's `putStream`, which is where a transfer
   * actually occupies a connection. The short delay is what makes overlap
   * possible at all: without it each transfer completes inside its own
   * microtask and the peak is 1 no matter what the limit says — a measurement
   * that would pass for a serialized implementation and an unbounded one alike.
   */
  async function peakConcurrentUploads(
    count: number,
    limit: number,
  ): Promise<{ peak: number; shipped: number }> {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < count; i += 1) await seedBlobRecord(local, 1 * MB);

    let inFlight = 0;
    let peak = 0;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (...args: unknown[]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await (realPutStream as (...a: unknown[]) => Promise<void>)(...args);
      } finally {
        inFlight -= 1;
      }
    };

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
      maxItems: count,
      transferConcurrency: limit,
    }).exchange();
    return { peak, shipped: result.shipped };
  }

  it("never has more transfers in flight than transferConcurrency allows", async () => {
    // The existing concurrency case sets the limit to 4 and then asserts
    // *truncation*, which says nothing about how many transfers ran at once: an
    // engine that serialized every upload, and one that dispatched all eight at
    // once, both pass it. On a handset the second is the one that matters — it
    // is a phone opening eight uploads on a cellular link because a round
    // happened to be large.
    const { peak, shipped } = await peakConcurrentUploads(8, 2);
    expect(shipped).toBe(8);
    expect(peak).toBeLessThanOrEqual(2);
    // …and it really did overlap, so the bound is what is holding it down
    // rather than an implementation that never had two transfers to begin with.
    expect(peak).toBe(2);
  });

  it("serializes at a limit of one", async () => {
    const { peak, shipped } = await peakConcurrentUploads(6, 1);
    expect(shipped).toBe(6);
    expect(peak).toBe(1);
  });

  it("uses the width it is given when there is work for it", async () => {
    // The control in the other direction: raising the limit raises the peak, so
    // the two cases above are measuring the limit and not a ceiling that
    // something else imposes.
    const { peak } = await peakConcurrentUploads(8, 6);
    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(6);
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
    const engine = engineFor(local, cloud, syncState, { maxBytes: 10 * MB });

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
      maxBytes: 10 * MB,
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
    const engine = engineFor(local, cloud, syncState, { maxBytes: 10 * MB });

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
    await engine.sync();

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

    await engineFor(local, cloud, createMemorySyncStateStore()).sync();
    expect(puts).toBe(1);
  });

  it("still fails every record naming a key whose transfer failed", async () => {
    // The flip side of sharing an outcome: one failure has to reach all of them,
    // or a record ships with bytes that never arrived.
    const { local, cloud } = await twoSides();
    const key = "apps/photos/syncable/identical-bytes.bin";
    const first = await seedSharingKey(local, key);
    const second = await seedSharingKey(local, key);
    cloud.storage.putStream = async () => {
      throw new Error("[test] permanent upload failure");
    };

    const result = await engineFor(local, cloud, createMemorySyncStateStore()).sync();

    expect(await cloud.db.get(first)).toBeNull();
    expect(await cloud.db.get(second)).toBeNull();
    expect(result.complete).toBe(false);
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

    expect(first.complete && second.complete, "neither may read the other as a failure").toBe(
      true,
    );
    expect(await cloud.db.get(id)).not.toBeNull();
    expect(await cloud.storage.has(key)).toBe(true);
    expect(puts, "each engine sends it once; nothing coordinates across them").toBe(2);
  });
});

describe("the responder's half of the byte budget", () => {
  /**
   * The budget the *caller* sets on what it will be handed back.
   *
   * Without it the cap is one-directional: a handset that limits itself to
   * 10 MB outbound could still be handed a hundred blob-carrying records
   * inbound and be expected to pull every one. The requester's own budget is
   * covered above; this is the responder honouring what it was asked for,
   * which is the side a phone depends on and the side nothing tested.
   */
  function responderFor(cloud: Side) {
    return createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
  }

  it("ships back no more bytes than the caller allowed", async () => {
    const { cloud } = await twoSides();
    for (let i = 0; i < 6; i += 1) await seedBlobRecord(cloud, 3 * MB);

    const response = await responderFor(cloud).exchange({
      watermarks: {},
      limit: 1000,
      maxBytes: 10 * MB,
    });

    expect(response.records.length).toBeGreaterThan(0);
    const bytes = response.records.reduce((sum, r) => sum + r.sizeBytes, 0);
    expect(bytes).toBeLessThanOrEqual(10 * MB);
    expect(response.hasMore).toBe(true);
  });

  it("falls back to its own maximum for a caller that names none", async () => {
    // An older peer that omits the field gets the responder's default rather
    // than an unbounded pull.
    const { cloud } = await twoSides();
    for (let i = 0; i < 6; i += 1) await seedBlobRecord(cloud, 10 * MB);

    const response = await responderFor(cloud).exchange({ watermarks: {}, limit: 1000 });

    const bytes = response.records.reduce((sum, r) => sum + r.sizeBytes, 0);
    expect(bytes).toBeLessThanOrEqual(25 * MB);
  });

  it("still ships one record larger than the whole budget", async () => {
    // Otherwise a single large video stalls the channel permanently: it never
    // fits, so it never ships, so nothing behind it ever moves either.
    const { cloud } = await twoSides();
    await seedBlobRecord(cloud, 50 * MB);

    const response = await responderFor(cloud).exchange({
      watermarks: {},
      limit: 1000,
      maxBytes: 1 * MB,
    });

    expect(response.records).toHaveLength(1);
  });

  it("does not charge blob-less rows against it", async () => {
    const { cloud } = await twoSides();
    for (let i = 0; i < 6; i += 1) await seedBlobless(cloud);

    const response = await responderFor(cloud).exchange({
      watermarks: {},
      limit: 1000,
      maxBytes: 1,
    });

    expect(response.records).toHaveLength(6);
    expect(response.hasMore).toBe(false);
  });
});

describe("sync() termination", () => {
  it("stops when a round achieves nothing, instead of reissuing it 10,000 times", async () => {
    const { local, cloud } = await twoSides();
    for (let i = 0; i < 5; i += 1) await seedBlobRecord(local, 3 * MB);

    // The earliest record's blob never uploads, so the contiguous-prefix rule
    // holds the whole author back and every round is byte-identical.
    const oldest = (await local.db.query({})).records.sort((a, b) =>
      a.updatedAt.wallTime - b.updatedAt.wallTime,
    )[0]!;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (key: string, ...rest: unknown[]) => {
      if (key === oldest.objectStorageKey) throw new Error("[test] permanent upload failure");
      return (realPutStream as (...a: unknown[]) => Promise<void>)(key, ...rest);
    };

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 4 * MB,
      maxItems: 100,
    }).sync({ maxRounds: 500 });

    expect(result.rounds).toBeLessThan(5);
    expect(result.shipped).toBe(0);
    // Not "complete" — work remains — and `stalled` says which of the two it
    // is, so a caller can tell "finished" from "wedged".
    expect(result.complete).toBe(false);
    expect(result.stalled).toBe(true);
  });

  it("does not report complete when the only record's upload keeps failing", async () => {
    // The case the scan signals cannot see. One record, a budget it fits
    // inside, and a transfer that never succeeds: both scans drain, so
    // `hasMore` and `outboundHasMore` are false and the loop used to take the
    // "both directions drained" exit — returning complete, not stalled, for a
    // record that is not in the cloud. That is the value `/sync/now` returns
    // and the one the phone's Sync button reads.
    const { local, cloud } = await twoSides();
    const id = await seedBlobRecord(local, 1 * MB);
    const record = (await local.db.get(id))!;
    cloud.storage.putStream = async () => {
      throw new Error("[test] permanent upload failure");
    };

    const result = await engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
    }).sync();

    expect(result.shipped).toBe(0);
    expect(await cloud.db.get(id)).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.stalled).toBe(true);
    expect(record.objectStorageKey).not.toBe("");
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

  it("resumes and finishes once the failing transfer starts working", async () => {
    // A stall is not a terminal state. Stopping is only safe because the
    // watermarks are untouched, so the next call picks up where this one gave up.
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
    expect((await engine.sync()).stalled).toBe(true);

    failing = false;
    const recovered = await engine.sync();
    expect(recovered.complete).toBe(true);
    for (const id of ids) expect(await cloud.db.get(id), id).not.toBeNull();
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
  it("keeps the floor when the repair round's upload failed", { timeout: 30_000 }, async () => {
    const { local, cloud } = await twoSides();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedBlobRecord(local, 1 * MB));

    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();

    // A hole in the middle: MAX(updated_at) is unchanged, so the coverage
    // report is unchanged and only a count comparison can see it.
    await loseFromMiddle(cloud, ids[2]!);
    await engine.verify();
    expect(Object.keys(await syncState.getRepairFloors())).toHaveLength(1);

    // Now the re-ship cannot complete. `outboundHasMore` describes the *scan*,
    // which fit the budget perfectly — so it stays false while the shipment is
    // silently truncated at the failed blob. Retiring on that reads "repair
    // done" and discards the only thing still asking for the row.
    const lost = ids[2]!;
    const lostKey = (await local.db.get(lost))!.objectStorageKey;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (key: string, ...rest: unknown[]) => {
      if (key === lostKey) throw new Error("[test] upload failure during repair");
      return (realPutStream as (...a: unknown[]) => Promise<void>)(key, ...rest);
    };
    await engine.sync();

    expect(await cloud.db.get(lost)).toBeNull();
    expect(
      Object.keys(await syncState.getRepairFloors()),
      "the floor is the only thing still asking for this row",
    ).toHaveLength(1);

    // And when the transfer recovers, the still-armed floor completes the job.
    cloud.storage.putStream = realPutStream as typeof cloud.storage.putStream;
    await engine.sync();
    expect(await cloud.db.get(lost)).not.toBeNull();
    expect(await syncState.getRepairFloors()).toEqual({});
  });

  it("retires only the authors whose shipment was not truncated", { timeout: 30_000 }, async () => {
    // Retirement is per author because failure is. One device's failed upload
    // must not discard a repair armed for another's.
    const { local, cloud } = await twoSides();
    const aaa: StarkeepId[] = [];
    const bbb: StarkeepId[] = [];
    for (let i = 0; i < 3; i += 1) {
      aaa.push(await seedAuthored(local, "aaa", 10 + i));
      bbb.push(await seedAuthored(local, "bbb", 50 + i));
    }
    const syncState = createMemorySyncStateStore();
    const engine = engineFor(local, cloud, syncState, { maxBytes: 100 * MB });
    await engine.sync();

    const aaaLostKey = (await local.db.get(aaa[1]!))!.objectStorageKey;
    await loseFromMiddle(cloud, aaa[1]!);
    await loseFromMiddle(cloud, bbb[1]!);
    await engine.verify();
    expect(Object.keys(await syncState.getRepairFloors()).sort()).toEqual(["aaa", "bbb"]);

    // Only aaa's re-ship fails.
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (key: string, ...rest: unknown[]) => {
      if (key === aaaLostKey) throw new Error("[test] upload failure");
      return (realPutStream as (...a: unknown[]) => Promise<void>)(key, ...rest);
    };
    await engine.sync();

    expect(Object.keys(await syncState.getRepairFloors())).toEqual(["aaa"]);
    expect(await cloud.db.get(bbb[1]!)).not.toBeNull();
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
