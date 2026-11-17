import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { describe, it, expect } from "vitest";
import { createDataRecord, generateId, type StarkeepId } from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";

/**
 * Replays of the counterexamples TLC found in `specs/exchange-round`.
 *
 * The responder applies a shipment one statement at a time, and each write
 * raises its author's coverage. It used to apply every record, then every
 * label, so between the last record and the first label the cloud reported
 * coverage over a label it did not hold yet, whenever that label's HLC sat
 * below one of the records. A label written before the next photo was
 * imported was enough (finding 1). A batch of labels sharing one HLC opens the
 * same window inside itself: the first row lifts coverage to the whole
 * timestamp (finding 2).
 *
 * Two ways such a window becomes permanent:
 *
 *   1. The round dies inside it. sync() pulls before it pushes whenever it owes
 *      the peer something, the pull reports coverage over the missing rows, and
 *      the push then scans above them. They never reach the cloud.
 *   2. Another device reads inside it. It advances its watermark past the
 *      missing rows, and is never offered them again.
 *
 * Each finding has a test for each route. The responder now applies in merged
 * per-author HLC order (fix B in `specs/exchange-round/FIXES.md`), so the two
 * tests for finding 1 are ordinary ones. The two for finding 2 are still
 * `it.fails`: they assert the correct outcome and currently fail. Fix C keeps
 * an HLC whole and makes them pass, and vitest then flags them for the
 * `.fails` to be removed.
 *
 * Finding 3, the lost update, is fixed by `putSnapshot` and a guarded
 * `putLabel` (fix A), so its test is an ordinary one.
 *
 * Finding 4 is on the requester, and no path in the code reaches it today; its
 * replay builds the shape by hand and is `it.fails` until fix E.
 */
describe("exchange round: findings from the TLA+ model", () => {
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

  async function seedLabel(side: Side, recordId: StarkeepId): Promise<void> {
    await side.db.upsertLabels([
      {
        recordId,
        appId: "photos",
        key: "favourite",
        value: "",
        recordType: "image/jpeg",
        hlc: side.clock.now(),
      },
    ]);
  }

  function engineFor(device: Side, cloud: Side) {
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    return createSyncEngine({
      localDatabaseAdapter: device.db,
      localObjectStorage: device.storage,
      remoteObjectStorage: cloud.storage,
      transport,
      clock: device.clock,
      syncState: createMemorySyncStateStore(),
      syncSharedRecords: true,
    });
  }

  async function sides(...nodeIds: string[]) {
    let t = 0;
    const wallClock = () => t++;
    const out: Record<string, Side> = {};
    for (const nodeId of nodeIds) {
      out[nodeId] = await buildSide({
        role: nodeId === "C" ? "cloud" : "local",
        nodeId,
        wallClock,
        appId: "photos",
      });
    }
    return out;
  }

  /** Photo, then a label on it, then the next photo: label HLC between the two records. */
  async function photoLabelPhoto(device: Side): Promise<StarkeepId> {
    const first = await seedRecord(device);
    await seedLabel(device, first);
    await seedRecord(device);
    return first;
  }

  async function cloudLabels(cloud: Side, recordId: StarkeepId) {
    return (await cloud.db.getLabelsByRecordIds([recordId])).get(recordId) ?? [];
  }

  // models/finding-crash.cfg
  it("a round that dies between records and labels does not lose the label", async () => {
    const { L, C } = await sides("L", "C");
    const labelled = await photoLabelPhoto(L);

    // The Lambda dies at the label write. Before fix B it died with both
    // records applied, and coverage already over the label.
    const putLabel = C.db.putLabel.bind(C.db);
    let dead = true;
    C.db.putLabel = async (label) => {
      if (dead) throw new Error("Lambda timed out");
      return putLabel(label);
    };
    const engine = engineFor(L, C);
    await expect(engine.exchange()).rejects.toThrow("Lambda timed out");
    dead = false;

    const result = await engine.sync();
    expect(result.complete).toBe(true);

    expect(await cloudLabels(C, labelled)).toHaveLength(1);
  });

  // models/finding-concurrent.cfg
  it("a device reading mid-apply is not left without the label", async () => {
    const { L, M, C } = await sides("L", "M", "C");
    const labelled = await photoLabelPhoto(L);

    // Hold L's round at its label write. Before fix B both records had
    // landed by then, and M was shipped the later one.
    const putLabel = C.db.putLabel.bind(C.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reachedLabels!: () => void;
    const atLabels = new Promise<void>((resolve) => (reachedLabels = resolve));
    C.db.putLabel = async (label) => {
      reachedLabels();
      await gate;
      return putLabel(label);
    };

    const lRound = engineFor(L, C).exchange();
    await atLabels;
    const m = engineFor(M, C);
    await m.sync(); // M reads the cloud inside the window.
    release();
    await lRound;

    // However long M keeps syncing, it is never offered the label.
    await m.sync();
    await m.sync();
    expect(await cloudLabels(C, labelled)).toHaveLength(1);
    expect((await M.db.getLabelsByRecordIds([labelled])).get(labelled) ?? []).toHaveLength(1);
  });

  // models/finding-batch-crash.cfg
  //
  // A batch of labels shares one HLC (`sdk.setLabels` takes one `clock.now()`
  // for the whole call), and the responder writes it one row per transaction.
  // The first row lifts coverage to that HLC, so a round that dies mid-batch
  // hides the rest of it from the pull-first round. No record is involved.
  it.fails("a round that dies mid-batch does not lose the rest of the batch", async () => {
    const { L, C } = await sides("L", "C");
    const id = await seedRecord(L);
    const engine = engineFor(L, C);
    await engine.sync();

    const hlc = L.clock.now();
    await L.db.upsertLabels(
      ["a", "b", "c"].map((value) => ({
        recordId: id,
        appId: "photos",
        key: "faces",
        value,
        recordType: "image/jpeg",
        hlc,
      })),
    );
    const putLabel = C.db.putLabel.bind(C.db);
    let writes = 0;
    C.db.putLabel = async (label) => {
      writes += 1;
      if (writes === 2) throw new Error("Lambda timed out");
      return putLabel(label);
    };
    await expect(engine.exchange()).rejects.toThrow("Lambda timed out");

    const result = await engine.sync();
    expect(result.complete).toBe(true);
    expect(await cloudLabels(C, id)).toHaveLength(3);
  });

  // models/finding-batch-concurrent.cfg
  //
  // The same batch, with another device reading between its first and second
  // row instead of a crash. The reader receives the first row, advances its
  // watermark to the batch's HLC, and the rest of the batch sits at that HLC,
  // which no later scan above the watermark returns.
  it.fails("a device reading mid-batch is not left without the rest of the batch", async () => {
    const { L, M, C } = await sides("L", "M", "C");
    const id = await seedRecord(L);
    const engine = engineFor(L, C);
    await engine.sync();

    const hlc = L.clock.now();
    await L.db.upsertLabels(
      ["a", "b", "c"].map((value) => ({
        recordId: id,
        appId: "photos",
        key: "faces",
        value,
        recordType: "image/jpeg",
        hlc,
      })),
    );

    // Hold L's round at the batch's second row, after the first landed.
    const putLabel = C.db.putLabel.bind(C.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reachedSecond!: () => void;
    const atSecond = new Promise<void>((resolve) => (reachedSecond = resolve));
    let writes = 0;
    C.db.putLabel = async (label) => {
      writes += 1;
      if (writes === 2) {
        reachedSecond();
        await gate;
      }
      return putLabel(label);
    };

    const lRound = engine.exchange();
    await atSecond;
    const m = engineFor(M, C);
    await m.sync(); // M reads the cloud inside the batch.
    release();
    await lRound;

    await m.sync();
    await m.sync();
    expect(await cloudLabels(C, id)).toHaveLength(3);
    expect((await M.db.getLabelsByRecordIds([id])).get(id) ?? []).toHaveLength(3);
  });

  // models/finding-device-batch.cfg
  //
  // The requester carries on past a row that will not apply, and advances
  // the author's watermark to the HLC of the row before it (`ownSafeAdvance`,
  // `items[stop - 1]`). When that row shares the failed row's HLC, the
  // watermark claims the failed row, and no later scan above it returns it.
  // Today only a record can fail on a device, and the only rows sharing an
  // HLC are a label batch and a record with its labels, which sort record
  // first; so no path in the code reaches this. Two records sharing an HLC
  // stand in for whatever first does.
  it.fails("a device that fails one row of an HLC is offered it again", async () => {
    const { A, M, C } = await sides("A", "M", "C");
    const hlc = A.clock.now();
    const ids: StarkeepId[] = [];
    for (let i = 0; i < 2; i++) {
      const id = generateId() as StarkeepId;
      const base = createDataRecord(
        {
          type: "image/jpeg",
          originAppId: "photos",
          contentHash: "sha256:x",
          objectStorageKey: "",
          mimeType: "application/octet-stream",
          sizeBytes: 0,
        },
        A.clock,
      );
      await A.db.put({ ...base, id, updatedAt: hlc });
      ids.push(id);
    }
    await engineFor(A, C).sync();

    // M's second write of the HLC fails once.
    const putSnapshot = M.db.putSnapshot.bind(M.db);
    let writes = 0;
    M.db.putSnapshot = async (record) => {
      writes += 1;
      if (writes === 2) throw new Error("[test] injected put failure");
      return putSnapshot(record);
    };
    const m = engineFor(M, C);
    await m.sync();
    await m.sync();
    await m.sync();

    for (const id of ids) expect(await M.db.get(id), id).not.toBeNull();
  });

  // models/finding-lww-race.cfg
  //
  // The responder's LWW check is a `get` followed by a `put`, and `put` is an
  // unconditional upsert in its own transaction. A round that read the row
  // before another round wrote a newer version then overwrites that version.
  it("a concurrent older write does not overwrite a newer one on the cloud", async () => {
    const { A, B, C } = await sides("A", "B", "C");
    const id = await seedRecord(A);
    await engineFor(A, C).sync();
    await engineFor(B, C).sync();

    // Both devices edit the record offline; B's edit is the newer.
    const edit = async (side: Side) => {
      const current = (await side.db.get(id))!;
      await side.db.put({ ...current, updatedAt: side.clock.now(), version: current.version + 1 });
    };
    await edit(A);
    await edit(B);
    const newest = (await B.db.get(id))!.updatedAt;

    // Hold A's round between the responder's get and its write.
    const putSnapshot = C.db.putSnapshot.bind(C.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reachedPut!: () => void;
    const atPut = new Promise<void>((resolve) => (reachedPut = resolve));
    let held = false;
    C.db.putSnapshot = async (record) => {
      if (!held && record.id === id && record.updatedAt.nodeId === "A") {
        held = true;
        reachedPut();
        await gate;
      }
      return putSnapshot(record);
    };

    const aRound = engineFor(A, C).exchange();
    await atPut;
    const b = engineFor(B, C);
    await b.sync(); // B's newer edit lands while A's put is held.
    release();
    await aRound;

    await b.sync();
    await engineFor(A, C).sync();
    expect((await C.db.get(id))!.updatedAt).toEqual(newest);
  });

  /** The ids whose image metadata is live, that is, not tombstoned. */
  async function liveMetadataIds(side: Side): Promise<string[]> {
    const result = await side.db.queryShared(
      { kind: "metadata", category: "image" },
      {
        mode: "rows",
        table: "record_image_metadata",
        select: ["record_id"],
        where: [],
        order: [],
        limit: 10,
        pageToken: null,
        include: [],
      },
    );
    if (result.mode !== "rows") throw new Error("expected rows");
    return result.rows.map((r) => String(r["record_id"]));
  }

  // Fix A, the responder's re-read. A tombstone that the guard keeps out must
  // not cascade to the metadata: the cascade follows the row the cloud holds
  // after the write, not the snapshot that lost.
  it("a tombstone kept out by a newer live row leaves the cloud's metadata live", async () => {
    const { A, B, C } = await sides("A", "B", "C");
    const id = await seedRecord(A);
    await engineFor(A, C).sync();
    await engineFor(B, C).sync();
    await C.db.putMetadata("image/jpeg", { recordId: id, width: 4032 });

    // A deletes offline, and B then edits, so B's live row is the newer.
    await A.db.delete(id, A.clock.now());
    const current = (await B.db.get(id))!;
    await B.db.put({ ...current, updatedAt: B.clock.now(), version: current.version + 1 });
    const newest = (await B.db.get(id))!.updatedAt;

    // Hold A's tombstone between the responder's get and its write.
    const putSnapshot = C.db.putSnapshot.bind(C.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reachedWrite!: () => void;
    const atWrite = new Promise<void>((resolve) => (reachedWrite = resolve));
    let held = false;
    C.db.putSnapshot = async (record) => {
      if (!held && record.id === id && record.updatedAt.nodeId === "A") {
        held = true;
        reachedWrite();
        await gate;
      }
      return putSnapshot(record);
    };

    const aRound = engineFor(A, C).exchange();
    await atWrite;
    await engineFor(B, C).sync(); // B's live row lands while A's write is held.
    release();
    await aRound;

    const stored = (await C.db.get(id))!;
    expect(stored.updatedAt).toEqual(newest);
    expect(stored.deletedAt).toBeNull();
    expect(await liveMetadataIds(C)).toEqual([id]);
  });

  // Fix A on the requester. A local edit can land between the inbound loop's
  // get and its write; the device keeps its edit, does not cascade the losing
  // tombstone to its metadata, does not count the row as applied, and the edit
  // still reaches the cloud.
  it("a local edit landing mid-apply survives an older inbound tombstone", async () => {
    const { A, L, C } = await sides("A", "L", "C");
    const id = await seedRecord(A);
    await engineFor(A, C).sync();
    const lEngine = engineFor(L, C);
    await lEngine.sync();
    await L.db.putMetadata("image/jpeg", { recordId: id, width: 4032 });

    await A.db.delete(id, A.clock.now());
    await engineFor(A, C).sync();

    // The local edit lands inside the apply, after the inbound loop's get.
    const putSnapshot = L.db.putSnapshot.bind(L.db);
    let edited = false;
    L.db.putSnapshot = async (record) => {
      if (!edited && record.id === id) {
        edited = true;
        const current = (await L.db.get(id))!;
        await L.db.put({ ...current, updatedAt: L.clock.now(), version: current.version + 1 });
      }
      return putSnapshot(record);
    };

    const result = await lEngine.exchange();
    expect(edited).toBe(true);
    expect(result.applied).toBe(0);
    const local = (await L.db.get(id))!;
    expect(local.deletedAt).toBeNull();
    expect(await liveMetadataIds(L)).toEqual([id]);

    await lEngine.sync();
    expect((await C.db.get(id))!.updatedAt).toEqual(local.updatedAt);
  });

  // Control: with nothing interleaved, the same writes sync completely.
  it("the same writes sync completely when nothing interleaves", async () => {
    const { L, M, C } = await sides("L", "M", "C");
    const labelled = await photoLabelPhoto(L);
    await engineFor(L, C).sync();
    await engineFor(M, C).sync();
    expect(await cloudLabels(C, labelled)).toHaveLength(1);
    expect((await M.db.getLabelsByRecordIds([labelled])).get(labelled) ?? []).toHaveLength(1);
  });
});
