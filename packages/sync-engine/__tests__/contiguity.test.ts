/**
 * Contiguous prefix across streams — the invariant, and the four ways it was
 * being broken.
 *
 * A coverage watermark is one timestamp per author covering *every* table on
 * the channel: shared records, labels, and each app-syncable table. The receiver
 * advances it over the merged inbound run. So a shipment is only truthful if it
 * is a contiguous prefix per author **across all of them at once** — ship a
 * label whose HLC sits above a record that was withheld, and the peer's
 * watermark lifts over that record and no round ever offers it again.
 *
 * Every failure here is silent and permanent. There is no error, no retry, no
 * divergence in any count either side keeps; the record is simply gone. That is
 * why these are pinned at the level of "is the row on the other node", rather
 * than by inspecting the shape of a page: a page can look right and still lose
 * data, which is exactly what happened.
 *
 * Each test names the shape it is defending against. They failed before
 * `round-cut.ts` existed.
 */

import { describe, it, expect } from "vitest";
import {
  createDataRecord,
  generateId,
  type HLCTimestamp,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import type { SyncStateStore } from "../src/types.js";

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
  opts: { maxBytes?: number; maxItems?: number } = {},
) {
  return createSyncEngine({
    localDatabaseAdapter: local.db,
    localObjectStorage: local.storage,
    remoteObjectStorage: cloud.storage,
    transport: createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    }),
    clock: local.clock,
    syncState,
    syncSharedRecords: true,
    ...opts,
  });
}

/** A record with a real blob, authored by `nodeId` at `wallTime` if given. */
async function seedRecord(
  side: Side,
  sizeBytes: number,
  authored?: { nodeId: string; wallTime: number },
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
      sizeBytes,
    },
    side.clock,
  );
  await side.db.put({
    ...base,
    id,
    ...(authored
      ? { updatedAt: { wallTime: authored.wallTime, counter: 0, nodeId: authored.nodeId } }
      : {}),
  });
  return id;
}

async function seedLabel(
  side: Side,
  recordId: StarkeepId,
  authored?: HLCTimestamp,
): Promise<void> {
  if (authored) {
    await side.db.putLabel({
      recordId,
      appId: "photos",
      key: "album",
      value: "x",
      recordType: "image/jpeg",
      updatedAt: authored,
      deletedAt: null,
    } as never);
    return;
  }
  await side.db.upsertLabels([
    {
      recordId,
      appId: "photos",
      key: "album",
      value: "x",
      recordType: "image/jpeg",
      hlc: side.clock.now(),
    },
  ]);
}

describe("contiguous prefix across streams", () => {
  it("does not strand an inbound record that the byte budget withheld behind a later label", async () => {
    // The responder used to trim records to the caller's byte budget and then
    // scan labels against the *item* budget, which the trim had left untouched.
    // So a label with a later HLC shipped while the record under it did not.
    const { local, cloud } = await twoSides();
    const r1 = await seedRecord(cloud, 3 * MB);
    const r2 = await seedRecord(cloud, 3 * MB);
    await seedLabel(cloud, r1);

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 4 * MB,
      maxItems: 100,
    });
    const result = await engine.sync();

    expect(result.complete).toBe(true);
    expect(await local.db.get(r1)).not.toBeNull();
    expect(await local.db.get(r2)).not.toBeNull();
  });

  it("keeps that record reachable across many rounds, not just eventually", async () => {
    // The distinguishing symptom of the bug was that it was *permanent*: the
    // watermark had moved past the record, so no number of further rounds could
    // recover it, and `sync()` truthfully reported "complete".
    const { local, cloud } = await twoSides();
    const stranded: StarkeepId[] = [];
    for (let i = 0; i < 4; i += 1) stranded.push(await seedRecord(cloud, 3 * MB));
    await seedLabel(cloud, stranded[0]!);

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 4 * MB,
      maxItems: 100,
    });
    for (let i = 0; i < 6; i += 1) await engine.sync();

    for (const id of stranded) expect(await local.db.get(id), id).not.toBeNull();
  });

  it("does not ship a label past a record of the same author the scan never reached", async () => {
    // Outbound mirror. The record scan and the label scan each had their own
    // item budget and each walked authors in nodeId order, so a first author
    // could consume the record budget while the label scan ran on to a second
    // author — shipping that author's label with its earlier record still
    // unscanned.
    const { local, cloud } = await twoSides();
    await seedRecord(local, 1 * MB, { nodeId: "aaa", wallTime: 100 });
    await seedRecord(local, 1 * MB, { nodeId: "aaa", wallTime: 101 });
    const early = await seedRecord(local, 1 * MB, { nodeId: "bbb", wallTime: 10 });
    await seedLabel(local, early, { wallTime: 11, counter: 0, nodeId: "bbb" });

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
      maxItems: 2,
    });
    for (let i = 0; i < 8; i += 1) await engine.sync();

    expect(await cloud.db.get(early)).not.toBeNull();
  });

  it("does not let one author that cannot drain starve the authors behind it", async () => {
    // The per-author seek loop walked authors in nodeId order and stopped when
    // the budget ran out, so an author that could never drain — one permanently
    // failing blob is enough — blocked every author sorted after it forever.
    const { local, cloud } = await twoSides();
    // `aaa` owes more than the whole item budget and its first blob will never
    // upload, so it can never drain. Under a budget spent in author order that
    // is the end of `bbb`, permanently — the scan stops inside `aaa` every
    // round and never reaches it.
    const stuck = await seedRecord(local, 1 * MB, { nodeId: "aaa", wallTime: 10 });
    await seedRecord(local, 1 * MB, { nodeId: "aaa", wallTime: 11 });
    await seedRecord(local, 1 * MB, { nodeId: "aaa", wallTime: 12 });
    const healthy = await seedRecord(local, 1 * MB, { nodeId: "bbb", wallTime: 20 });

    const failingKey = (await local.db.get(stuck))!.objectStorageKey;
    const realPutStream = cloud.storage.putStream.bind(cloud.storage);
    cloud.storage.putStream = async (key: string, ...rest: unknown[]) => {
      if (key === failingKey) throw new Error("[test] permanent upload failure");
      return (realPutStream as (...a: unknown[]) => Promise<void>)(key, ...rest);
    };

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
      maxItems: 2,
    });
    for (let i = 0; i < 5; i += 1) await engine.sync({ maxRounds: 5 });

    // `aaa` is genuinely blocked — the contiguous-prefix rule holds its whole
    // range behind the failed blob, which is correct.
    expect(await cloud.db.get(stuck)).toBeNull();
    // `bbb` shares no author with it and must be unaffected.
    expect(await cloud.db.get(healthy), "bbb must not be starved by aaa").not.toBeNull();
  });

  /**
   * The shape that needs the ceiling specifically, rather than the shared cut.
   *
   * One author's record scan stops part-way, and that same author has a label
   * whose HLC lands *between* the stopping point and the next author's rows —
   * so sorting globally and cutting to the budget still lets the label through,
   * with a record of that author underneath it unscanned. The stopping point
   * has to be carried out of the scan and honoured; it cannot be inferred from
   * the candidates, because the missing rows are by definition not among them.
   */
  it("holds back a label sitting above the point its author's record scan stopped", async () => {
    const { local, cloud } = await twoSides();
    // `aaa` owes four records; the budget lets the scan return two.
    await seedRecord(local, 1 * MB, { nodeId: "aaa", wallTime: 10 });
    await seedRecord(local, 1 * MB, { nodeId: "aaa", wallTime: 20 });
    const underneath = await seedRecord(local, 1 * MB, { nodeId: "aaa", wallTime: 22 });
    await seedRecord(local, 1 * MB, { nodeId: "aaa", wallTime: 40 });
    // A label at 25 — above where the record scan stops (20), below the next
    // author's rows, so a global sort places it comfortably inside the budget.
    // Shipping it lifts the peer's watermark for `aaa` to 25 and the record at
    // 22 is never offered again.
    await seedLabel(local, underneath, { wallTime: 25, counter: 0, nodeId: "aaa" });
    await seedRecord(local, 1 * MB, { nodeId: "bbb", wallTime: 100 });
    await seedRecord(local, 1 * MB, { nodeId: "bbb", wallTime: 110 });

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
      maxItems: 4,
    });
    for (let i = 0; i < 8; i += 1) await engine.sync();

    expect(await cloud.db.get(underneath), "record at 22 must not be skipped").not.toBeNull();
  });

  it("holds back an inbound label the same way, when the pull is the truncated side", async () => {
    // The responder half of the same shape. It ran a different assembly path
    // until both sides were made to share one.
    const { local, cloud } = await twoSides();
    await seedRecord(cloud, 1 * MB, { nodeId: "aaa", wallTime: 10 });
    await seedRecord(cloud, 1 * MB, { nodeId: "aaa", wallTime: 20 });
    const underneath = await seedRecord(cloud, 1 * MB, { nodeId: "aaa", wallTime: 22 });
    await seedRecord(cloud, 1 * MB, { nodeId: "aaa", wallTime: 40 });
    await seedLabel(cloud, underneath, { wallTime: 25, counter: 0, nodeId: "aaa" });
    await seedRecord(cloud, 1 * MB, { nodeId: "bbb", wallTime: 100 });
    await seedRecord(cloud, 1 * MB, { nodeId: "bbb", wallTime: 110 });

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 100 * MB,
      maxItems: 4,
    });
    for (let i = 0; i < 8; i += 1) await engine.sync();

    expect(await local.db.get(underneath), "record at 22 must not be skipped").not.toBeNull();
  });

  it("converges with records and labels interleaved under a tight byte budget", async () => {
    // The general case the three above are corners of: two streams, both
    // truncating, in both directions, over many rounds. Nothing may be lost.
    const { local, cloud } = await twoSides();
    const cloudIds: StarkeepId[] = [];
    const localIds: StarkeepId[] = [];
    for (let i = 0; i < 6; i += 1) {
      cloudIds.push(await seedRecord(cloud, 2 * MB));
      localIds.push(await seedRecord(local, 2 * MB));
    }
    for (const id of cloudIds) await seedLabel(cloud, id);
    for (const id of localIds) await seedLabel(local, id);

    const engine = engineFor(local, cloud, createMemorySyncStateStore(), {
      maxBytes: 3 * MB,
      maxItems: 4,
    });
    for (let i = 0; i < 12; i += 1) await engine.sync();

    for (const id of cloudIds) expect(await local.db.get(id), `pull ${id}`).not.toBeNull();
    for (const id of localIds) expect(await cloud.db.get(id), `push ${id}`).not.toBeNull();
    for (const id of [...cloudIds, ...localIds]) {
      expect(await local.db.getLabel(id, "photos", "album", "x"), `label ${id}`).not.toBeNull();
      expect(await cloud.db.getLabel(id, "photos", "album", "x"), `label ${id}`).not.toBeNull();
    }
  });
});
