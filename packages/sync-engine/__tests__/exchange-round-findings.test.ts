import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { describe, it, expect } from "vitest";
import { createDataRecord, generateId, type StarkeepId } from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";

/**
 * Replays of the counterexamples TLC found in `specs/exchange-round`.
 *
 * The responder applies a shipment one statement at a time: every record, then
 * every label (in-process-transport.ts, steps 2 and 2b). Each write raises its
 * author's coverage. So between the last record and the first label the cloud
 * reports coverage over a label it does not hold yet, whenever that label's
 * HLC sits below one of the records. A label written before the next photo is
 * imported is enough.
 *
 * Two ways that window becomes permanent:
 *
 *   1. The round dies inside it. sync() pulls before it pushes whenever it owes
 *      the peer something, the pull reports coverage over the label, and the
 *      push then scans above it. The label never reaches the cloud.
 *   2. Another device reads inside it. It receives the later record, advances
 *      its watermark past the label, and is never offered the label again.
 *
 * Both tests are `it.fails`: they assert the correct outcome and currently
 * fail. When the responder applies in merged per-author HLC order, one
 * transaction per HLC, they start passing and vitest flags them for the
 * `.fails` to be removed.
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
  it.fails("a round that dies between records and labels does not lose the label", async () => {
    const { L, C } = await sides("L", "C");
    const labelled = await photoLabelPhoto(L);

    // The Lambda dies after the records phase: the first label write never runs.
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
  it.fails("a device reading mid-apply is not left without the label", async () => {
    const { L, M, C } = await sides("L", "M", "C");
    const labelled = await photoLabelPhoto(L);

    // Hold L's round at its first label write, after both records landed.
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

  // models/finding-lww-race.cfg
  //
  // The responder's LWW check is a `get` followed by a `put`, and `put` is an
  // unconditional upsert in its own transaction. A round that read the row
  // before another round wrote a newer version then overwrites that version.
  it.fails("a concurrent older write does not overwrite a newer one on the cloud", async () => {
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

    // Hold A's round between the responder's get and its put.
    const put = C.db.put.bind(C.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reachedPut!: () => void;
    const atPut = new Promise<void>((resolve) => (reachedPut = resolve));
    let held = false;
    C.db.put = async (record) => {
      if (!held && record.id === id && record.updatedAt.nodeId === "A") {
        held = true;
        reachedPut();
        await gate;
      }
      return put(record);
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
