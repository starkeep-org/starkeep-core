import { describe, it, expect } from "vitest";
import { createDataRecord, generateId, type StarkeepId } from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";
import type { SyncStateStore, Watermarks } from "../src/types.js";

/**
 * Label sync over the Drive channel.
 *
 * Labels are shared data, so they ride the Drive channel with records — a
 * second stream on the same channel rather than a channel of their own. That
 * makes two things load-bearing and easy to get subtly wrong:
 *
 *   1. The coverage watermark is a **union over both tables**. Missing the
 *      label half lets it overstate coverage and silently drop a label.
 *   2. Records and labels apply in **merged per-node HLC order**, so the
 *      "holdings are a contiguous per-node prefix" claim the watermark rests
 *      on holds across both streams.
 *
 * Neither failure corrupts data — LWW is idempotent and a re-ship is harmless
 * — which is exactly why they need explicit tests: they are invisible until a
 * label goes missing.
 */
describe("label sync", () => {
  function makeSyncState(): SyncStateStore {
    let watermarks: Watermarks = {};
    let peerWatermarks: Watermarks = {};
    return {
      async getWatermarks() {
        return watermarks;
      },
      async setWatermarks(w) {
        watermarks = w;
      },
      async getPeerWatermarks() {
        return peerWatermarks;
      },
      async setPeerWatermarks(w) {
        peerWatermarks = w;
      },
      async getHlcClockState() {
        return null;
      },
      async setHlcClockState() {},
    };
  }

  type Side = Awaited<ReturnType<typeof buildSide>>;

  async function seedRecord(side: Side): Promise<StarkeepId> {
    const id = generateId() as StarkeepId;
    await side.db.put({
      ...createDataRecord(
        {
          type: "image/jpeg",
          originAppId: "photos",
          contentHash: "sha256:x",
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

  /**
   * A record with a real blob key whose bytes are *missing* locally, so
   * `transferFile` fails and the engine halts that node for the round. The
   * seedRecord above has an empty key, which the engine treats as blobless.
   */
  async function seedRecordWithMissingBlob(side: Side): Promise<StarkeepId> {
    const id = generateId() as StarkeepId;
    await side.db.put({
      ...createDataRecord(
        {
          type: "image/jpeg",
          originAppId: "photos",
          contentHash: "sha256:missing",
          objectStorageKey: `shared/image/jpeg/missing/${id}`,
          mimeType: "image/jpeg",
          sizeBytes: 10,
        },
        side.clock,
      ),
      id,
    });
    return id;
  }

  async function seedLabel(
    side: Side,
    recordId: StarkeepId,
    appId: string,
    key: string,
    value: string | null = null,
  ): Promise<void> {
    await side.db.upsertLabels([
      { recordId, appId, key, value, recordType: "image/jpeg", hlc: side.clock.now() },
    ]);
  }

  function driveEngine(
    local: Side,
    cloud: Side,
    opts: { syncState?: SyncStateStore; pageLimit?: number; scanPageSize?: number } = {},
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
      syncState: opts.syncState ?? makeSyncState(),
      syncSharedRecords: true,
      ...(opts.pageLimit !== undefined ? { pageLimit: opts.pageLimit } : {}),
      ...(opts.scanPageSize !== undefined ? { scanPageSize: opts.scanPageSize } : {}),
    });
  }

  async function twoSides() {
    let t = 0;
    const wallClock = () => t++;
    return {
      local: await buildSide({ role: "local", nodeId: "L", wallClock, appId: "photos" }),
      cloud: await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: "photos" }),
    };
  }

  it("ships a label to the peer alongside its record", async () => {
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(local);
    await seedLabel(local, recordId, "alpha", "faces-detected");

    await driveEngine(local, cloud).exchange();

    expect(await cloud.db.get(recordId)).not.toBeNull();
    const landed = (await cloud.db.getLabelsByRecordIds([recordId])).get(recordId);
    expect(landed).toHaveLength(1);
    expect(landed![0]).toMatchObject({
      appId: "alpha",
      key: "faces-detected",
      value: null,
      recordType: "image/jpeg",
    });
  });

  it("pulls a label the peer has and this side does not", async () => {
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(cloud);
    await seedLabel(cloud, recordId, "alpha", "faces-detected", "yes");

    await driveEngine(local, cloud).exchange();

    const landed = (await local.db.getLabelsByRecordIds([recordId])).get(recordId);
    expect(landed).toHaveLength(1);
    expect(landed![0].value).toBe("yes");
  });

  it("propagates a retraction rather than resurrecting the label", async () => {
    // The reason apply uses putLabel (a verbatim snapshot write) rather than
    // upsertLabels: the latter clears deleted_at, so an inbound retraction
    // would arrive and immediately un-retract itself.
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(local);
    await seedLabel(local, recordId, "alpha", "faces-detected");
    await driveEngine(local, cloud).exchange();
    expect((await cloud.db.getLabelsByRecordIds([recordId])).get(recordId)).toHaveLength(1);

    await local.db.retractLabels([
      { recordId, appId: "alpha", key: "faces-detected", hlc: local.clock.now() },
    ]);
    await driveEngine(local, cloud).exchange();

    expect((await cloud.db.getLabelsByRecordIds([recordId])).get(recordId)).toBeUndefined();
    // The tombstone row itself is present — that is what makes the retraction
    // syncable at all.
    const tombstone = await cloud.db.getLabel(recordId, "alpha", "faces-detected");
    expect(tombstone).not.toBeNull();
    expect(tombstone!.deletedAt).not.toBeNull();
  });

  it("propagates a retraction on the PULL path too", async () => {
    // The push direction above exercises the transport's apply; this one
    // exercises the engine's. Both must use a verbatim snapshot write — a
    // mutation that swaps either for upsertLabels resurrects the retraction,
    // and only one of these two tests would catch it.
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(cloud);
    await seedLabel(cloud, recordId, "alpha", "faces-detected");
    await driveEngine(local, cloud).exchange();
    expect((await local.db.getLabelsByRecordIds([recordId])).get(recordId)).toHaveLength(1);

    await cloud.db.retractLabels([
      { recordId, appId: "alpha", key: "faces-detected", hlc: cloud.clock.now() },
    ]);
    await driveEngine(local, cloud).exchange();

    expect((await local.db.getLabelsByRecordIds([recordId])).get(recordId)).toBeUndefined();
    const tombstone = await local.db.getLabel(recordId, "alpha", "faces-detected");
    expect(tombstone).not.toBeNull();
    expect(tombstone!.deletedAt).not.toBeNull();
  });

  it("resolves concurrent writes by HLC last-writer-wins on the label's own row", async () => {
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(local);
    await driveEngine(local, cloud).exchange();

    // Both sides set the same key; cloud's HLC is later.
    await seedLabel(local, recordId, "alpha", "quality", "from-local");
    await seedLabel(cloud, recordId, "alpha", "quality", "from-cloud");

    await driveEngine(local, cloud).exchange();

    const onLocal = (await local.db.getLabelsByRecordIds([recordId])).get(recordId)!;
    expect(onLocal.find((l) => l.key === "quality")!.value).toBe("from-cloud");
  });

  it("keeps a label's LWW domain separate from its record's", async () => {
    // The reason labels are their own table: records are conflict-resolved by
    // whole-row LWW, so a concurrent record update would otherwise wholesale
    // overwrite a label written on another device.
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(local);
    await driveEngine(local, cloud).exchange();

    // Device A labels; device B concurrently updates the record row.
    await seedLabel(local, recordId, "alpha", "faces-detected");
    const onCloud = (await cloud.db.get(recordId))!;
    await cloud.db.put({
      ...onCloud,
      originalFilename: "renamed.jpg",
      updatedAt: cloud.clock.now(),
      version: onCloud.version + 1,
    });

    await driveEngine(local, cloud).exchange();

    // Both survive. Neither ate the other.
    expect((await local.db.get(recordId))!.originalFilename).toBe("renamed.jpg");
    expect((await cloud.db.getLabelsByRecordIds([recordId])).get(recordId)).toHaveLength(1);
  });

  it("includes labels in the responder's coverage watermark", async () => {
    // A watermark computed over records alone would sit below the label's HLC,
    // so the requester would keep re-shipping — or worse, in the reverse
    // direction, believe coverage it doesn't have.
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(cloud);
    await seedLabel(cloud, recordId, "alpha", "k");

    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const response = await transport.exchange({ watermarks: {} });

    const labelWatermarks = await cloud.db.getLabelNodeWatermarks();
    const labelHlc = labelWatermarks["C"];
    expect(labelHlc).toBeDefined();
    // The union covers the label, which is strictly later than the record.
    expect(response.responderWatermarks["C"]).toEqual(labelHlc);
    void local;
  });

  it("a per-app channel drops inbound labels, as it drops shared records", async () => {
    // Without this guard the channel split holds for records and silently
    // does not for labels — the kind of gap that gets left out because the
    // responder "shouldn't" ship them.
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(cloud);
    await seedLabel(cloud, recordId, "alpha", "k");

    // Responder is a Drive channel (so it *will* ship labels), requester is a
    // per-app channel — deliberately mismatched to exercise the guard.
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
      transport,
      clock: local.clock,
      syncState: makeSyncState(),
      syncSharedRecords: false,
      appSyncableSource: {
        namespaces: local.namespaces,
        applier: local.applier as never,
      },
    });

    await engine.exchange();

    expect(await local.db.get(recordId)).toBeNull();
    expect((await local.db.getLabelsByRecordIds([recordId])).size).toBe(0);
  });

  it("a per-app responder never ships labels it holds", async () => {
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(cloud);
    await seedLabel(cloud, recordId, "alpha", "k");

    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      appSyncableSource: { namespaces: cloud.namespaces, applier: cloud.applier },
      syncSharedRecords: false,
    });
    const response = await transport.exchange({ watermarks: {} });

    expect(response.records).toHaveLength(0);
    expect(response.labels).toHaveLength(0);
    void local;
  });

  it("applies records and labels in one merged per-node HLC order", async () => {
    // The contiguous-prefix rule the coverage watermark rests on has to hold
    // across BOTH streams, not within each separately. Interleave them so a
    // per-stream ordering would visibly differ from a merged one.
    const { local, cloud } = await twoSides();

    const first = await seedRecord(local);
    await seedLabel(local, first, "alpha", "k", "1");
    const second = await seedRecord(local);
    await seedLabel(local, second, "alpha", "k", "2");

    await driveEngine(local, cloud).exchange();

    // Everything landed, and the peer's watermark covers the whole prefix —
    // which is only sound if the merge was per-node rather than per-stream.
    expect(await cloud.db.get(first)).not.toBeNull();
    expect(await cloud.db.get(second)).not.toBeNull();
    expect((await cloud.db.getLabelsByRecordIds([first, second])).size).toBe(2);

    const recordWatermarks = await cloud.db.getNodeWatermarks();
    const labelWatermarks = await cloud.db.getLabelNodeWatermarks();
    // The last thing written on L was a label, so the label side is the
    // higher of the two — the union has to reach it.
    expect(labelWatermarks["L"]!.wallTime).toBeGreaterThan(
      recordWatermarks["L"]!.wallTime,
    );

    // A second exchange ships nothing: the watermark genuinely covered both.
    const before = await cloud.db.getLabelNodeWatermarks();
    await driveEngine(local, cloud).exchange();
    expect(await cloud.db.getLabelNodeWatermarks()).toEqual(before);
  });

  it("does not touch the record row when only a label changes", async () => {
    // The single most important implementation rule, checked end to end: a
    // label write must not bump records.updated_at, or every peer re-ships
    // the whole record and its watermark churns.
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(local);
    await driveEngine(local, cloud).exchange();
    const recordWatermarksBefore = await cloud.db.getNodeWatermarks();

    await seedLabel(local, recordId, "alpha", "k");
    await driveEngine(local, cloud).exchange();

    expect(await cloud.db.getNodeWatermarks()).toEqual(recordWatermarksBefore);
    expect((await cloud.db.getLabelsByRecordIds([recordId])).get(recordId)).toHaveLength(1);
  });

  it("blocks a later same-node LABEL when an earlier record's blob transfer fails", async () => {
    // The contiguous-prefix rule has to hold ACROSS the two streams, not
    // within each. HLC order on node L:
    //   t1 — record, blob present  → ships
    //   t2 — record, blob MISSING  → blocked
    //   t3 — label on the t1 record → must NOT ship
    // If the label shipped, the peer watermark would leapfrog the blocked
    // record and it would never be re-sent. Nothing here corrupts data — LWW
    // is idempotent — which is exactly why it needs an explicit test.
    const { local, cloud } = await twoSides();

    const early = await seedRecord(local);
    const blocked = await seedRecordWithMissingBlob(local);
    await seedLabel(local, early, "alpha", "faces-detected");

    const syncState = makeSyncState();
    await driveEngine(local, cloud, { syncState }).exchange();

    expect(await cloud.db.get(early)).not.toBeNull();
    expect(await cloud.db.get(blocked)).toBeNull();
    // The label sorts after the blocked record on the same node, so it waits.
    expect(await cloud.db.getLabel(early, "alpha", "faces-detected")).toBeNull();

    const peer = await syncState.getPeerWatermarks();
    expect(peer["L"]).toEqual((await local.db.get(early))!.updatedAt);

    // Repair the blob and re-run: the record ships, and the label follows.
    await local.storage.put(
      (await local.db.get(blocked))!.objectStorageKey,
      new Uint8Array([1]),
      { contentType: "image/jpeg" },
    );
    await driveEngine(local, cloud, { syncState }).exchange();

    expect(await cloud.db.get(blocked)).not.toBeNull();
    expect(await cloud.db.getLabel(early, "alpha", "faces-detected")).not.toBeNull();
  });

  it("ships a label that precedes the failure, and holds only what follows it", async () => {
    // The mirror of the case above: a label earlier in the same node's HLC
    // order than the failure is part of the contiguous prefix and must ship,
    // or a single bad blob would stall label delivery indefinitely.
    const { local, cloud } = await twoSides();

    const early = await seedRecord(local);
    await seedLabel(local, early, "alpha", "before");
    await seedRecordWithMissingBlob(local);
    await seedLabel(local, early, "alpha", "after");

    await driveEngine(local, cloud).exchange();

    expect(await cloud.db.getLabel(early, "alpha", "before")).not.toBeNull();
    expect(await cloud.db.getLabel(early, "alpha", "after")).toBeNull();
  });

  it("the responder skips inbound labels from a node halted by a failed app row", async () => {
    // Same rule on the apply side of the transport: an app row that fails to
    // apply halts its node for the round, and the labels behind it must not
    // be applied over the gap.
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(local);
    const label = {
      recordId,
      appId: "alpha",
      key: "k",
      value: null,
      recordType: "image/jpeg",
      createdAt: local.clock.now(),
      updatedAt: local.clock.now(),
      nodeId: "L",
      deletedAt: null,
    };

    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      appSyncableSource: { namespaces: cloud.namespaces, applier: cloud.applier },
      syncSharedRecords: true,
    });

    await transport.exchange({
      watermarks: {},
      labels: [label],
      // An app row for an app the responder doesn't know — the documented way
      // a node gets halted for the round.
      appSyncableRows: [
        {
          timestamp: { ...label.updatedAt, wallTime: label.updatedAt.wallTime - 1 },
          appId: "not-installed",
          table: "test_rows",
          op: "insert" as const,
          row: { id: "x" },
        },
      ],
    });

    expect(await cloud.db.getLabel(recordId, "alpha", "k")).toBeNull();

    // The same label with nothing halting its node does land — so the
    // assertion above is about the halt, not about labels never applying.
    await transport.exchange({ watermarks: {}, labels: [label] });
    expect(await cloud.db.getLabel(recordId, "alpha", "k")).not.toBeNull();
  });

  it("carries a label backlog larger than one scan page across rounds", async () => {
    // The outbound scan pages through queryLabels with its own cursor. Every
    // other test here has two labels, so nothing exercises the loop — or the
    // cursor advancing correctly between pages, which is where a scan strands
    // rows forever rather than failing.
    const { local, cloud } = await twoSides();
    const recordId = await seedRecord(local);
    for (let i = 0; i < 12; i++) {
      await seedLabel(local, recordId, "alpha", `k${String(i).padStart(2, "0")}`);
    }

    const syncState = makeSyncState();
    // Both below the backlog: pageLimit caps the round, scanPageSize the scan.
    const engine = () =>
      driveEngine(local, cloud, { syncState, pageLimit: 5, scanPageSize: 2 });

    let rounds = 0;
    let landed = 0;
    do {
      await engine().exchange();
      landed = (await cloud.db.getLabelsByRecordIds([recordId])).get(recordId)?.length ?? 0;
      expect(++rounds).toBeLessThan(20);
    } while (landed < 12);

    // Every label arrived exactly once, and it genuinely took several rounds
    // rather than one oversized response.
    expect(landed).toBe(12);
    expect(rounds).toBeGreaterThan(1);
  });

  it("shares the round's budget between records and labels", async () => {
    // Records and labels compete for one `limit`, so neither stream can
    // starve the other. With pageLimit=2 and both streams non-empty, a round
    // must carry two items total — not two of each.
    const { local, cloud } = await twoSides();
    const first = await seedRecord(local);
    await seedLabel(local, first, "alpha", "k1");
    const second = await seedRecord(local);
    await seedLabel(local, second, "alpha", "k2");

    const syncState = makeSyncState();
    await driveEngine(local, cloud, { syncState, pageLimit: 2 }).exchange();

    const records = [await cloud.db.get(first), await cloud.db.get(second)].filter(Boolean);
    const labels =
      ((await cloud.db.getLabelsByRecordIds([first])).get(first)?.length ?? 0) +
      ((await cloud.db.getLabelsByRecordIds([second])).get(second)?.length ?? 0);
    expect(records.length + labels).toBe(2);
    // And in merged HLC order, which puts the first record and its label first.
    expect(await cloud.db.get(first)).not.toBeNull();
    expect(await cloud.db.getLabel(first, "alpha", "k1")).not.toBeNull();

    // Converges over further rounds without losing anything.
    for (let i = 0; i < 5; i++) {
      await driveEngine(local, cloud, { syncState, pageLimit: 2 }).exchange();
    }
    expect(await cloud.db.get(second)).not.toBeNull();
    expect(await cloud.db.getLabel(second, "alpha", "k2")).not.toBeNull();
  });

  it("tolerates a label arriving before its record", async () => {
    // No FK backs record_id and readers reach labels *from* records, so an
    // orphan is simply invisible until its record lands. The apply path must
    // never validate record existence — only the API write path does.
    const { local, cloud } = await twoSides();
    const orphanId = generateId() as StarkeepId;
    await cloud.db.upsertLabels([
      {
        recordId: orphanId,
        appId: "alpha",
        key: "k",
        value: null,
        recordType: "image/jpeg",
        hlc: cloud.clock.now(),
      },
    ]);

    await driveEngine(local, cloud).exchange();

    // Landed without error, and is invisible until the record shows up.
    expect(await local.db.getLabel(orphanId, "alpha", "k")).not.toBeNull();
    expect(await local.db.get(orphanId)).toBeNull();
  });
});
