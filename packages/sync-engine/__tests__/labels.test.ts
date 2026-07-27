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

  function driveEngine(local: Side, cloud: Side) {
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
      syncState: makeSyncState(),
      syncSharedRecords: true,
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
