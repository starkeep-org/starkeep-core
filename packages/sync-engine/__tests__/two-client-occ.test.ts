import { describe, it, expect, beforeEach } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  SyncStatus,
  type HLCClock,
  type DataRecord,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import type { SyncEngine } from "../src/types.js";

/**
 * Two-client OCC suite. Simulates two data-server nodes (A + B) talking to a
 * shared "cloud" via an in-process transport. Exercises the production code
 * paths that the HTTP transport would also hit — same `decidePushAccept` /
 * `decidePullApply` — without the HTTP dance.
 *
 * This fills the gap that scripts/test-sync.sh can't hit: the data-server
 * currently has no update endpoint, so OCC rejection must be verified at the
 * SyncEngine level.
 */

interface Node {
  readonly db: MockDatabaseAdapter;
  readonly localObj: MockObjectStorageAdapter;
  readonly remoteObj: MockObjectStorageAdapter;
  readonly clock: HLCClock;
  readonly engine: SyncEngine;
}

interface World {
  readonly cloudDb: MockDatabaseAdapter;
  readonly cloudObj: MockObjectStorageAdapter;
  readonly nodeA: Node;
  readonly nodeB: Node;
  readonly ownerId: string;
}

async function makeWorld(): Promise<World> {
  // Monotonic wall-clock source shared by every clock so HLC timestamps
  // are totally orderable inside the test.
  let wall = 1000;
  const tick = () => wall++;

  const cloudDb = new MockDatabaseAdapter();
  const cloudObj = new MockObjectStorageAdapter();
  const cloudClock = createHLCClock({ nodeId: "cloud", wallClockFunction: tick });
  await cloudDb.init();
  await cloudObj.init();

  const mkNode = async (nodeId: string): Promise<Node> => {
    const db = new MockDatabaseAdapter();
    const localObj = new MockObjectStorageAdapter();
    const remoteObj = cloudObj;
    const clock = createHLCClock({ nodeId, wallClockFunction: tick });
    await db.init();
    await localObj.init();

    const transport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
    });

    const engine = createSyncEngine({
      localDatabaseAdapter: db,
      localObjectStorage: localObj,
      remoteObjectStorage: remoteObj,
      transport,
      clock,
    });

    return { db, localObj, remoteObj, clock, engine };
  };

  return {
    cloudDb,
    cloudObj,
    nodeA: await mkNode("node-a"),
    nodeB: await mkNode("node-b"),
    ownerId: "craig",
  };
}

async function createOnNode(
  node: Node,
  ownerId: string,
  content: Record<string, unknown>,
): Promise<DataRecord> {
  const record = createDataRecord(
    { type: "@test/note", ownerId, originAppId: "@starkeep/sync-engine", content },
    node.clock,
  );
  await node.db.put(record);
  await node.engine.recordChange("create", record, { baseVersion: null });
  return record;
}

async function updateOnNode(
  node: Node,
  existing: DataRecord,
  patch: Partial<DataRecord>,
): Promise<DataRecord> {
  const baseVersion = existing.version;
  const updated: DataRecord = {
    ...existing,
    ...patch,
    version: baseVersion + 1,
    updatedAt: node.clock.now(),
    syncStatus: SyncStatus.PendingPush,
  };
  await node.db.put(updated);
  await node.engine.recordChange("update", updated, { baseVersion });
  return updated;
}

describe("two-client OCC end-to-end", () => {
  let world: World;

  beforeEach(async () => {
    world = await makeWorld();
  });

  it("A creates, B pulls and sees it", async () => {
    const { nodeA, nodeB, ownerId } = world;

    const record = await createOnNode(nodeA, ownerId, { body: "hello from A" });
    const push = await nodeA.engine.push();
    expect(push.accepted).toEqual([record.id]);

    await nodeB.engine.pull();
    const onB = await nodeB.db.get(record.id);
    expect(onB).not.toBeNull();
    expect((onB as DataRecord).content).toEqual({ body: "hello from A" });
    expect(onB!.syncStatus).toBe(SyncStatus.Synced);
  });

  it("concurrent updates to same record: second push is rejected (OCC)", async () => {
    const { nodeA, nodeB, ownerId } = world;

    // Seed: create on A, propagate to cloud and to B.
    const seed = await createOnNode(nodeA, ownerId, { body: "v1" });
    await nodeA.engine.push();
    await nodeB.engine.pull();

    const seedOnB = (await nodeB.db.get(seed.id)) as DataRecord;
    expect(seedOnB.version).toBe(seed.version);

    // Both nodes edit their local copy independently.
    await updateOnNode(nodeA, seed, { content: { body: "A wins race" } });
    await updateOnNode(nodeB, seedOnB, { content: { body: "B wins race" } });

    // A pushes first — accepted.
    const pushA = await nodeA.engine.push();
    expect(pushA.accepted).toEqual([seed.id]);
    expect(pushA.rejected).toHaveLength(0);

    // B pushes second — rejected, because server advanced past B's baseVersion.
    const pushB = await nodeB.engine.push();
    expect(pushB.accepted).toHaveLength(0);
    expect(pushB.rejected).toHaveLength(1);
    expect(pushB.rejected[0].reason).toBe("version-mismatch");
    expect((pushB.rejected[0].serverRecord as DataRecord).content).toEqual({
      body: "A wins race",
    });

    // B's local record is now parked as Conflict.
    const bAfter = (await nodeB.db.get(seed.id)) as DataRecord;
    expect(bAfter.syncStatus).toBe(SyncStatus.Conflict);
    expect(nodeB.engine.getConflicts()).toHaveLength(1);
  });

  it("pull-side dirty-conflict: B's unsynced edit survives an incoming remote update", async () => {
    const { nodeA, nodeB, ownerId } = world;

    const seed = await createOnNode(nodeA, ownerId, { body: "v1" });
    await nodeA.engine.push();
    await nodeB.engine.pull();

    const seedOnB = (await nodeB.db.get(seed.id)) as DataRecord;

    // A pushes a v2 (server now has v2).
    await updateOnNode(nodeA, seed, { content: { body: "remote v2" } });
    await nodeA.engine.push();

    // B has its own unsynced v2. Pull must NOT clobber it.
    await updateOnNode(nodeB, seedOnB, { content: { body: "local v2" } });
    await nodeB.engine.pull();

    const bAfter = (await nodeB.db.get(seed.id)) as DataRecord;
    expect(bAfter.content).toEqual({ body: "local v2" });
    expect(bAfter.syncStatus).toBe(SyncStatus.Conflict);

    const conflicts = nodeB.engine.getConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].source).toBe("pull");
    expect((conflicts[0].server as DataRecord).content).toEqual({
      body: "remote v2",
    });
  });

  it("after OCC rejection on B, clearing the conflict and re-pushing with fresh baseVersion succeeds", async () => {
    const { nodeA, nodeB, ownerId } = world;

    const seed = await createOnNode(nodeA, ownerId, { body: "v1" });
    await nodeA.engine.push();
    await nodeB.engine.pull();

    const seedOnB = (await nodeB.db.get(seed.id)) as DataRecord;

    // Race: A writes v2, B writes v2. A pushes first.
    await updateOnNode(nodeA, seed, { content: { body: "A v2" } });
    await updateOnNode(nodeB, seedOnB, { content: { body: "B v2" } });
    await nodeA.engine.push();
    await nodeB.engine.push(); // rejected

    // Simulate resolving "keep local": B pulls the server version, rebases
    // its edit on top (version = server.version + 1), clears conflict,
    // re-pushes.
    const conflict = nodeB.engine.getConflicts()[0];
    const serverVersion = (conflict.server as DataRecord).version;
    const rebased: DataRecord = {
      ...(conflict.local as DataRecord),
      version: serverVersion + 1,
      updatedAt: nodeB.clock.now(),
      syncStatus: SyncStatus.PendingPush,
    };
    await nodeB.db.put(rebased);
    nodeB.engine.clearConflict(seed.id);
    await nodeB.engine.recordChange("update", rebased, {
      baseVersion: serverVersion,
    });

    const finalPush = await nodeB.engine.push();
    expect(finalPush.accepted).toEqual([seed.id]);
    expect(finalPush.rejected).toHaveLength(0);

    // A pulls and sees B's resolution.
    await nodeA.engine.pull();
    const onA = (await nodeA.db.get(seed.id)) as DataRecord;
    expect(onA.content).toEqual({ body: "B v2" });
    expect(onA.version).toBe(serverVersion + 1);
  });

  it("cursors advance: second push from a node with no new changes is a no-op", async () => {
    const { nodeA, ownerId } = world;

    await createOnNode(nodeA, ownerId, { body: "one" });
    const first = await nodeA.engine.push();
    expect(first.accepted).toHaveLength(1);

    const second = await nodeA.engine.push();
    expect(second.accepted).toHaveLength(0);
    expect(second.rejected).toHaveLength(0);
  });
});
