/**
 * The acquisition order end to end: the catalogue scan, the pass that drains
 * the queue, and the property the whole change exists for.
 *
 * The property is in "a cold sync is bounded by the budget" below, and it is
 * the only test here that would fail loudly if this work were reverted. The
 * rest exist so that when it fails, the reason is legible.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  createHLCClock,
  createDataRecord,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import {
  createResidencyManager,
  residencyHooks,
  type ResidencyManager,
} from "../src/residency-manager.js";
import { scanForAcquirable } from "../src/acquisition-scan.js";
import { runAcquisition } from "../src/acquisition.js";
import type { NodeRetentionPolicy } from "../src/residency-policy.js";
import type { SyncEngine } from "../src/types.js";

const KB = 1024;
const BLOB_BYTES = 4 * KB;

/**
 * A policy with one line that matters — platform originals — and a budget
 * stated in whole blobs, so every assertion below can be written in items.
 */
function policyHolding(blobs: number, over: { prefetch?: boolean } = {}): NodeRetentionPolicy {
  return {
    platform: {
      rows: { "original:image": { prefetch: over.prefetch ?? true, share: 1 } },
      fallback: { prefetch: true, share: 0 },
      budgetBytes: blobs * BLOB_BYTES,
    },
    apps: {},
    appFallback: { rows: {}, fallback: { prefetch: true, share: 1 }, budgetBytes: 1024 * KB },
  };
}

interface Node {
  readonly engine: SyncEngine;
  readonly manager: ResidencyManager;
  readonly localDb: MockDatabaseAdapter;
  readonly cloudDb: MockDatabaseAdapter;
  readonly localStorage: MockObjectStorageAdapter;
  readonly cloudStorage: MockObjectStorageAdapter;
  /** Bytes the cloud has been asked for, across every route. */
  bytesRead(): number;
  /** The handle the resident-set index lives on, so a rebuilt node sees its rows. */
  readonly rawDb: DatabaseSync;
  /** Every blob key in the library, oldest capture date first. */
  readonly keysOldestFirst: readonly string[];
  policy: NodeRetentionPolicy;
}

/**
 * A cloud holding `libraryBlobs` originals, and a local node with a budget.
 *
 * Records are minted oldest-first, which is the whole point: a sync round walks
 * the change log forward, so the order they are created here is the order the
 * node is offered them.
 */
async function buildNode(options: {
  libraryBlobs: number;
  policy: NodeRetentionPolicy;
}): Promise<Node> {
  let time = 1000;
  const localClock = createHLCClock({ nodeId: "local", wallClockFunction: () => time++ });
  const cloudClock = createHLCClock({ nodeId: "cloud", wallClockFunction: () => time++ });

  const localDb = new MockDatabaseAdapter();
  const cloudDb = new MockDatabaseAdapter();
  const localStorage = new MockObjectStorageAdapter();
  const cloudStorage = new MockObjectStorageAdapter();
  await Promise.all([localDb.init(), cloudDb.init(), localStorage.init(), cloudStorage.init()]);
  const capturedAtByKey = new Map<string, string>();

  for (let i = 0; i < options.libraryBlobs; i += 1) {
    const record = await putCloudBlob(cloudDb, cloudStorage, cloudClock, i);
    // A capture date per photograph, increasing with the change log — which is
    // what a real library looks like and what makes this fixture reproduce the
    // problem. Without distinct dates every candidate ranks identically, the
    // displacement check can never say yes, and a cold sync bounds itself for
    // the wrong reason.
    //
    // Written to the *local* database because that is where the residency
    // manager reads recency from, and it is there before the round arrives
    // exactly as a metadata row that synced ahead of its blob would be.
    const capturedAt = new Date(Date.UTC(2005 + i, 0, 1)).toISOString();
    await localDb.putMetadata("image/jpeg", { recordId: record.id, captured_at: capturedAt });
    capturedAtByKey.set(record.objectStorageKey!, capturedAt);
  }

  // Counted rather than mocked: the question the regression test asks is how
  // many bytes crossed the wire, and only the storage adapter knows.
  let bytesRead = 0;
  const countingCloud = new Proxy(cloudStorage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "get" && prop !== "getStream") return value;
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (result !== null) bytesRead += BLOB_BYTES;
        return result;
      };
    },
  }) as MockObjectStorageAdapter;

  const rawDb = new DatabaseSync(":memory:");
  const manager = createResidencyManager({
    localDb: rawDb as never,
    databaseAdapter: localDb,
    localObjectStorage: localStorage,
    sizeClassKeys: { photos: "rendition" },
    isCloudNode: false,
    policy: options.policy,
    durability: { minimumReplicas: 1 },
  });

  const engine = createSyncEngine({
    localDatabaseAdapter: localDb,
    localObjectStorage: localStorage,
    remoteObjectStorage: countingCloud,
    transport: createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      objectStorage: cloudStorage,
    }),
    clock: localClock,
    syncState: createMemorySyncStateStore(),
    residency: residencyHooks(manager),
  });

  return {
    engine,
    manager,
    localDb,
    cloudDb,
    localStorage,
    cloudStorage,
    bytesRead: () => bytesRead,
    rawDb,
    keysOldestFirst: [...capturedAtByKey.keys()],
    policy: options.policy,
  };
}

async function putCloudBlob(
  cloudDb: MockDatabaseAdapter,
  cloudStorage: MockObjectStorageAdapter,
  cloudClock: ReturnType<typeof createHLCClock>,
  index: number,
): Promise<DataRecord> {
  // Real bytes and a real hash: the transfer path verifies the object as it
  // streams, so a fabricated hash would fail the transfer and make a residency
  // test look like a residency bug.
  const blob = Buffer.alloc(BLOB_BYTES, index % 251);
  const hash = createHash("sha256").update(blob as unknown as Uint8Array).digest("hex");
  const checksum = createHash("sha256").update(blob as unknown as Uint8Array).digest("base64");
  const record = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: hash,
      objectStorageKey: `shared/image/${hash.slice(0, 2)}/${hash}`,
      mimeType: "image/jpeg",
      sizeBytes: blob.length,
    },
    cloudClock,
  );
  await cloudDb.put(record);
  // With a checksum, so the eviction pass can prove a replica survives here
  // before it drops anything. Without one it refuses, correctly, and every
  // convergence assertion below would be measuring that refusal instead.
  await cloudStorage.put(record.objectStorageKey, blob, { checksumSha256: checksum });
  return record;
}

/** Everything the local node actually holds bytes for. */
async function heldKeys(node: Node): Promise<string[]> {
  const page = await node.localStorage.list("", {});
  return [...page.keys].sort();
}

async function scanAll(node: Node): Promise<number> {
  let cursor: string | null = null;
  let queued = 0;
  for (;;) {
    const result = await scanForAcquirable({
      databaseAdapter: node.localDb,
      consider: (candidate) => node.manager.considerForAcquisition(candidate),
      cursor,
      maxRecords: 50,
    });
    queued += result.queued;
    cursor = result.nextCursor;
    if (cursor === null) return queued;
  }
}

async function drainAcquisition(node: Node, maxBytes = 1e9): Promise<number> {
  let landed = 0;
  for (let tick = 0; tick < 50; tick += 1) {
    const outcomes = await runAcquisition({
      engine: node.engine,
      manager: node.manager,
      databaseAdapter: node.localDb,
      policy: node.policy,
      maxBytes,
    });
    const thisTick = outcomes.reduce((sum, o) => sum + o.landed, 0);
    landed += thisTick;
    if (thisTick === 0) return landed;
  }
  return landed;
}

/**
 * Run the pass and the eviction pass alternately until neither changes
 * anything — the steady state the phone's job graph reaches on its own.
 *
 * Both are needed, and neither is enough. The acquisition pass admits a blob
 * that outranks enough of what is held *on the promise* that eviction will free
 * those bytes; eviction is the half with the durability evidence and is the
 * only thing allowed to delete. Testing either alone measures a transient.
 */
async function converge(node: Node): Promise<void> {
  const probes = [{ nodeId: "cloud", storage: node.cloudStorage }];
  for (let round = 0; round < 30; round += 1) {
    const landed = await drainAcquisition(node);
    const outcomes = await node.manager.runEviction(probes);
    const evicted = outcomes.reduce((sum, o) => sum + o.evicted.length, 0);
    if (landed === 0 && evicted === 0) return;
  }
}

// ---------------------------------------------------------------------------
// The property the whole change exists for
// ---------------------------------------------------------------------------

describe("a cold sync is bounded by the budget", () => {
  /**
   * The regression test. Without it this change is unfalsifiable.
   *
   * A sync round walks the change log oldest-first, because forward order *is*
   * the coverage claim the watermark makes. On a node whose budget binds, every
   * arrival is newer than everything held, so an admission rule that lets a
   * newer blob displace an older one admits **all** of them: the line ends up
   * holding the right bytes, having transferred the entire library to get
   * there, and rewritten the device's flash a budget at a time on the way.
   *
   * The bound asserted here is one budget's worth per line, once — D3's claim,
   * stated in bytes.
   */
  it("transfers about one budget's worth, not the whole library", async () => {
    const budgetBlobs = 4;
    const libraryBlobs = 40;
    const node = await buildNode({
      libraryBlobs,
      policy: policyHolding(budgetBlobs),
    });

    await node.engine.sync({ maxRounds: 200 });

    // The library is fully known — this is a bound on bytes, never on metadata.
    const local = await node.localDb.query({ limit: 1000 });
    expect(local.records).toHaveLength(libraryBlobs);

    // One budget's worth, with a blob of slack for the boundary case where the
    // line admits one more than it can hold and eviction settles it later.
    expect(node.bytesRead()).toBeLessThanOrEqual((budgetBlobs + 1) * BLOB_BYTES);
    // And the whole library is emphatically not what happened.
    expect(node.bytesRead()).toBeLessThan((libraryBlobs / 2) * BLOB_BYTES);
  });

  it("leaves the rest queued rather than forgotten", async () => {
    const node = await buildNode({ libraryBlobs: 20, policy: policyHolding(4) });
    await node.engine.sync({ maxRounds: 200 });

    // Everything the round declined for want of room is on the queue, which is
    // what makes `staged` an honest answer for it.
    const queued = node.manager.deferredCandidates("starkeep:original:image", 100);
    expect(queued.length).toBeGreaterThan(0);
    // A queue row is not a claim about disk.
    expect(node.manager.index.usageOf("starkeep:original:image")).toBeLessThanOrEqual(
      4 * BLOB_BYTES,
    );
  });
});

describe("the pass converges on the same set, in the right order", () => {
  /**
   * The cost changes; the contents must not.
   *
   * A budget holding four of twenty blobs should end up holding the four
   * *newest*, whether it got there by displacing its way through the library or
   * by deferring and then draining a best-first queue. That is the whole claim:
   * this change is about how many bytes move, not about which ones stay.
   */
  it("holds the newest of the class after the queue drains", async () => {
    // The pass fills to the budget and eviction frees to the budget, so the
    // line settles at exactly the budget. One number with two readers is what
    // makes this a fixed point rather than an eviction/refetch cycle — two
    // different levels would pump against each other for ever.
    const budgetBlobs = 4;
    const settledBlobs = 4;
    const node = await buildNode({ libraryBlobs: 20, policy: policyHolding(budgetBlobs) });
    await node.engine.sync({ maxRounds: 200 });
    // Acquisition and eviction alternate, which is how the phone runs them —
    // two jobs in one graph. They are two halves of one ordering: the pass
    // admits what outranks what is held, and the pass that actually deletes is
    // the one with the durability evidence.
    await converge(node);

    // "Newest" by the record's own date — the last term of the eviction order,
    // and the only one that separates these photographs, since none has been
    // opened.
    expect(await heldKeys(node)).toEqual(node.keysOldestFirst.slice(-settledBlobs).sort());
  });

  /**
   * The stop condition, which is what makes an idle tick free.
   *
   * The queue is best-first, so the first candidate the line declines for want
   * of room proves nothing behind it can win. A line that has converged must
   * therefore perform no transfers at all, however long its queue is.
   */
  it("performs no transfers once a line has converged", async () => {
    const node = await buildNode({ libraryBlobs: 20, policy: policyHolding(4) });
    await node.engine.sync({ maxRounds: 200 });
    await drainAcquisition(node);

    const before = node.bytesRead();
    const outcomes = await runAcquisition({
      engine: node.engine,
      manager: node.manager,
      databaseAdapter: node.localDb,
      policy: node.policy,
      maxBytes: 1e9,
    });

    expect(node.bytesRead()).toBe(before);
    const line = outcomes.find((o) => o.budgetLine.key === "starkeep:original:image");
    expect(line?.landed).toBe(0);
    expect(line?.stoppedAtBudget).toBe(true);
  });

  it("stops at the byte bound for the tick", async () => {
    const node = await buildNode({ libraryBlobs: 20, policy: policyHolding(10) });
    await node.engine.sync({ maxRounds: 200 });

    const before = node.bytesRead();
    await runAcquisition({
      engine: node.engine,
      manager: node.manager,
      databaseAdapter: node.localDb,
      policy: node.policy,
      // One blob's worth. The OS decides when a background job stops, so a
      // pass that ignored this would be a unit that never finishes.
      maxBytes: BLOB_BYTES,
    });

    expect(node.bytesRead() - before).toBeLessThanOrEqual(2 * BLOB_BYTES);
  });
});

// ---------------------------------------------------------------------------
// The four populations only the scan can find
// ---------------------------------------------------------------------------

describe("the catalogue scan finds what no round will offer again", () => {
  it("queues a library that landed before the queue existed", async () => {
    const node = await buildNode({ libraryBlobs: 12, policy: policyHolding(2) });
    await node.engine.sync({ maxRounds: 200 });

    // Simulate the pre-change state: the rounds elided without deferring, so
    // the queue is empty and every declined record is invisible.
    for (const entry of node.manager.deferredCandidates("starkeep:original:image", 100)) {
      node.manager.dropDeferred(entry.objectStorageKey);
    }
    expect(node.manager.deferredCandidates("starkeep:original:image", 100)).toHaveLength(0);

    expect(await scanAll(node)).toBeGreaterThan(0);
    expect(
      node.manager.deferredCandidates("starkeep:original:image", 100).length,
    ).toBeGreaterThan(0);
  });

  it("queues a blob this node evicted after its round completed", async () => {
    const node = await buildNode({ libraryBlobs: 4, policy: policyHolding(4) });
    await node.engine.sync({ maxRounds: 200 });

    const held = await heldKeys(node);
    const dropped = held[0]!;
    await node.localStorage.delete(dropped);
    node.manager.noteDeparture(dropped);

    // The watermark moved past this record long ago and the peer considers it
    // delivered, so the scan is the only thing that can find it.
    await scanAll(node);
    expect(
      node.manager
        .deferredCandidates("starkeep:original:image", 100)
        .map((e) => e.objectStorageKey),
    ).toContain(dropped);

    await drainAcquisition(node);
    expect(await node.localStorage.has(dropped)).toBe(true);
  });

  /**
   * Population 3, and the one place the vocabulary used to lie outright.
   *
   * Bytes that went away locally with no resident-set row at all — on a phone,
   * a camera-roll asset the user deleted — reported `staged` with no queue, no
   * row, and no route home. The scan is what fixes it, and it needs no separate
   * mechanism to do so.
   */
  it("queues a blob whose bytes went away with no row behind them", async () => {
    const node = await buildNode({ libraryBlobs: 4, policy: policyHolding(4) });
    await node.engine.sync({ maxRounds: 200 });

    const held = await heldKeys(node);
    const vanished = held[0]!;
    await node.localStorage.delete(vanished);
    node.manager.index.remove(vanished);

    await scanAll(node);
    expect(
      node.manager
        .deferredCandidates("starkeep:original:image", 100)
        .map((e) => e.objectStorageKey),
    ).toContain(vanished);
  });

  it("acquires what a raised budget newly affords", async () => {
    const node = await buildNode({ libraryBlobs: 12, policy: policyHolding(2) });
    await node.engine.sync({ maxRounds: 200 });
    await drainAcquisition(node);
    const heldAtSmallBudget = (await heldKeys(node)).length;

    // The gap `types.ts` admitted to: nothing backfilled after a budget rose.
    const raised = await buildNodeAtRaisedBudget(node, 8);
    await scanAll(raised);
    await drainAcquisition(raised);

    expect((await heldKeys(raised)).length).toBeGreaterThan(heldAtSmallBudget);
  });

  it("does not queue a class the node holds only on demand", async () => {
    const node = await buildNode({
      libraryBlobs: 6,
      policy: policyHolding(6, { prefetch: false }),
    });
    await node.engine.sync({ maxRounds: 200 });

    // `prefetch: false` means "cache it when someone asks", and queueing it
    // would make that setting mean nothing at all.
    expect(await scanAll(node)).toBe(0);
  });

  it("does not queue a tombstoned record", async () => {
    const node = await buildNode({ libraryBlobs: 4, policy: policyHolding(1) });
    await node.engine.sync({ maxRounds: 200 });

    const local = await node.localDb.query({ limit: 100 });
    for (const record of local.records) {
      await node.localDb.delete(record.id as StarkeepId, record.updatedAt);
    }
    for (const entry of node.manager.deferredCandidates("starkeep:original:image", 100)) {
      node.manager.dropDeferred(entry.objectStorageKey);
    }

    expect(await scanAll(node)).toBe(0);
  });

  it("resumes from its cursor rather than restarting", async () => {
    const node = await buildNode({ libraryBlobs: 10, policy: policyHolding(1) });
    await node.engine.sync({ maxRounds: 200 });

    const first = await scanForAcquirable({
      databaseAdapter: node.localDb,
      consider: (candidate) => node.manager.considerForAcquisition(candidate),
      maxRecords: 3,
    });
    expect(first.recordsScanned).toBe(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await scanForAcquirable({
      databaseAdapter: node.localDb,
      consider: (candidate) => node.manager.considerForAcquisition(candidate),
      cursor: first.nextCursor,
      maxRecords: 100,
    });
    expect(first.recordsScanned + second.recordsScanned).toBe(10);
    expect(second.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The distinction D5 exists to protect
// ---------------------------------------------------------------------------

describe("acquireBlob is subject to the policy where fetchBlob is not", () => {
  /**
   * Two methods rather than a flag, and this is the behaviour the split is for.
   *
   * `fetchBlob` answers a direct request — somebody opened this photo — and
   * refusing it to stay under a cache budget is not a defensible behaviour, so
   * it bypasses the decision and lets the accounting push the line over.
   * `acquireBlob` is a background pass working through a queue, and if it
   * bypassed the decision too it would fetch the whole library back the moment
   * the queue existed.
   */
  it("declines past the budget where fetchBlob lands the bytes", async () => {
    const node = await buildNode({ libraryBlobs: 6, policy: policyHolding(1) });
    await node.engine.sync({ maxRounds: 200 });
    await converge(node);

    const queued = node.manager.deferredCandidates("starkeep:original:image", 10);
    expect(queued.length).toBeGreaterThan(0);
    const entry = queued[0]!;
    const record = (await node.localDb.get(entry.recordId as StarkeepId))!;
    const manifest = {
      fileHash: record.contentHash,
      objectStorageKey: record.objectStorageKey!,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType ?? undefined,
    };
    const candidate = {
      recordId: record.id,
      objectStorageKey: record.objectStorageKey!,
      sizeBytes: record.sizeBytes,
      type: record.type,
      parentId: record.parentId,
      appId: null,
      originAppId: record.originAppId,
      recencyAtMs: null,
      lastOpenedAtMs: null,
    };

    const acquired = await node.engine.acquireBlob(manifest, candidate);
    expect(acquired).toEqual({ outcome: "declined", reason: "budget-exhausted" });
    expect(await node.localStorage.has(manifest.objectStorageKey)).toBe(false);

    // The same blob, asked for directly.
    expect(await node.engine.fetchBlob(manifest, candidate)).toBe(true);
    expect(await node.localStorage.has(manifest.objectStorageKey)).toBe(true);
  });
});

/**
 * The same library and the same local database, under a bigger budget.
 *
 * Built rather than mutated because a policy is validated once, at manager
 * construction — which is the shape a real budget change takes too: the node is
 * rebuilt around the new policy, and nothing about the old one survives except
 * what is on disk.
 */
async function buildNodeAtRaisedBudget(node: Node, blobs: number): Promise<Node> {
  const policy = policyHolding(blobs);
  const manager = createResidencyManager({
    localDb: node.rawDb as never,
    databaseAdapter: node.localDb,
    localObjectStorage: node.localStorage,
    sizeClassKeys: { photos: "rendition" },
    isCloudNode: false,
    policy,
    durability: { minimumReplicas: 1 },
  });
  const engine = createSyncEngine({
    localDatabaseAdapter: node.localDb,
    localObjectStorage: node.localStorage,
    remoteObjectStorage: node.cloudStorage,
    transport: createInProcessSyncTransport({
      databaseAdapter: node.cloudDb,
      clock: createHLCClock({ nodeId: "cloud2" }),
      objectStorage: node.cloudStorage,
    }),
    clock: createHLCClock({ nodeId: "local" }),
    syncState: createMemorySyncStateStore(),
    residency: residencyHooks(manager),
  });
  return { ...node, engine, manager, policy };
}
