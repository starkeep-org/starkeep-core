import { describe, it, expect } from "vitest";
import {
  compareHLC,
  createDataRecord,
  createHLCClock,
  serializeHLC,
  type HLCClock,
  type HLCTimestamp,
} from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { computeRecordWatermarks } from "../src/watermarks.js";
import {
  makeMockAppSource,
  type MockAppRowStore,
} from "./sync-test-harness/mock-app-source.js";
import type {
  AppSyncableRowEntry,
  ScanCapableApplier,
  SyncStateStore,
  SyncTransport,
  Watermarks,
} from "../src/types.js";

/**
 * Unit + integration coverage for `responderWatermarks` — the responder's
 * per-node coverage report that the requester replaces its `peerWatermarks`
 * with (push-is-peer-authoritative). Companion end-to-end redeploy cases
 * live in s4-watermark-reset.test.ts (S4-012/013).
 */

let sharedTime = 1000;
const wallClock = () => sharedTime++;

function makeClock(nodeId: string): HLCClock {
  return createHLCClock({ nodeId, wallClockFunction: wallClock });
}

// objectStorageKey "" = metadata-only record; blob transfer paths are
// covered by the S3/S4 suites.
function makeRecord(clock: HLCClock) {
  return createDataRecord(
    {
      type: "@test/doc",
      originAppId: "test",
      contentHash: "sha256:x",
      objectStorageKey: "",
      sizeBytes: 0,
    },
    clock,
  );
}

function appRow(
  appId: string,
  table: string,
  id: string,
  timestamp: HLCTimestamp,
): AppSyncableRowEntry {
  return {
    timestamp,
    appId,
    table,
    op: "insert",
    row: { id, payload: `payload-${id}`, updated_at: serializeHLC(timestamp) },
  };
}

function makeSyncState(): SyncStateStore & {
  seedPeer(w: Watermarks): void;
} {
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
    seedPeer(w) {
      peerWatermarks = w;
    },
  };
}

interface Device {
  readonly clock: HLCClock;
  readonly db: MockDatabaseAdapter;
  readonly storage: MockObjectStorageAdapter;
  readonly syncState: ReturnType<typeof makeSyncState>;
  readonly app: MockAppRowStore;
  exchange(): ReturnType<ReturnType<typeof createSyncEngine>["exchange"]>;
}

async function makeDevice(
  nodeId: string,
  transport: SyncTransport,
  remoteStorage: MockObjectStorageAdapter,
): Promise<Device> {
  const clock = makeClock(nodeId);
  const db = new MockDatabaseAdapter();
  const storage = new MockObjectStorageAdapter();
  await db.init();
  await storage.init();
  const syncState = makeSyncState();
  const app = makeMockAppSource("test-app", [
    { name: "test_rows", pkColumns: ["id"] },
  ]);
  const engine = createSyncEngine({
    localDatabaseAdapter: db,
    localObjectStorage: storage,
    remoteObjectStorage: remoteStorage,
    transport,
    clock,
    syncState,
    appSyncableSource: { namespaces: app.namespaces, applier: app.applier },
  });
  return { clock, db, storage, syncState, app, exchange: () => engine.exchange() };
}

async function makeCloud(appSource?: MockAppRowStore, syncSharedRecords = true) {
  const clock = makeClock("cloud");
  const db = new MockDatabaseAdapter();
  const storage = new MockObjectStorageAdapter();
  await db.init();
  await storage.init();
  const transport = createInProcessSyncTransport({
    databaseAdapter: db,
    clock,
    objectStorage: storage,
    syncSharedRecords,
    ...(appSource
      ? {
          appSyncableSource: {
            namespaces: appSource.namespaces,
            applier: appSource.applier,
          },
        }
      : {}),
  });
  return { clock, db, storage, transport };
}

describe("responderWatermarks — coverage computation", () => {
  it("an empty responder reports {}", async () => {
    const cloud = await makeCloud();
    const res = await cloud.transport.exchange({ watermarks: {} });
    expect(res.responderWatermarks).toEqual({});
  });

  it("reports per-node MAX over full state, not just the requested delta", async () => {
    const cloud = await makeCloud();
    const nodeA = makeClock("node-a");
    const nodeB = makeClock("node-b");
    await cloud.db.put(makeRecord(nodeA));
    const latestA = makeRecord(nodeA);
    await cloud.db.put(latestA);
    const onlyB = makeRecord(nodeB);
    await cloud.db.put(onlyB);

    // Advertise everything already seen — the response ships no records,
    // but coverage still spans the full state.
    const res = await cloud.transport.exchange({
      watermarks: {
        "node-a": latestA.updatedAt,
        "node-b": onlyB.updatedAt,
      },
    });
    expect(res.records).toEqual([]);
    expect(serializeHLC(res.responderWatermarks["node-a"]!)).toBe(
      serializeHLC(latestA.updatedAt),
    );
    expect(serializeHLC(res.responderWatermarks["node-b"]!)).toBe(
      serializeHLC(onlyB.updatedAt),
    );
  });

  it("is computed after applying inbound — a just-pushed record is covered", async () => {
    const cloud = await makeCloud();
    const device = makeClock("device-1");
    const pushed = makeRecord(device);
    const res = await cloud.transport.exchange({
      watermarks: {},
      records: [pushed],
    });
    expect(serializeHLC(res.responderWatermarks["device-1"]!)).toBe(
      serializeHLC(pushed.updatedAt),
    );
  });

  it("channel split: a per-app channel covers only its app rows, never shared records", async () => {
    const appSource = makeMockAppSource("test-app", [
      { name: "test_rows", pkColumns: ["id"] },
    ]);
    const cloud = await makeCloud(appSource, false);
    // Shared record present in the same DB — different plane, must not leak.
    const sharedNode = makeClock("shared-node");
    await cloud.db.put(makeRecord(sharedNode));
    const dev = makeClock("device-1");
    const row = appRow("test-app", "test_rows", "r1", dev.now());
    await appSource.applier.apply(row);

    const res = await cloud.transport.exchange({ watermarks: {} });
    expect(res.responderWatermarks["shared-node"]).toBeUndefined();
    expect(serializeHLC(res.responderWatermarks["device-1"]!)).toBe(
      serializeHLC(row.timestamp),
    );
  });

  it("Drive channel with no app source covers only shared records", async () => {
    const cloud = await makeCloud();
    const node = makeClock("node-a");
    const rec = makeRecord(node);
    await cloud.db.put(rec);
    const res = await cloud.transport.exchange({ watermarks: { "node-a": rec.updatedAt } });
    expect(Object.keys(res.responderWatermarks)).toEqual(["node-a"]);
  });

  it("adapter getNodeWatermarks (indexed path) matches the reference in-memory fold", async () => {
    const db = new MockDatabaseAdapter();
    await db.init();
    const clocks = [makeClock("n1"), makeClock("n2"), makeClock("n3")];
    const all: ReturnType<typeof makeRecord>[] = [];
    for (let i = 0; i < 12; i++) {
      const rec = makeRecord(clocks[i % clocks.length]!);
      await db.put(rec);
      all.push(rec);
    }
    const viaAdapter = await db.getNodeWatermarks();
    const viaFold = computeRecordWatermarks(all);
    expect(Object.keys(viaAdapter).sort()).toEqual(Object.keys(viaFold).sort());
    for (const [node, hlc] of Object.entries(viaFold)) {
      expect(compareHLC(viaAdapter[node]!, hlc)).toBe(0);
    }
  });

  it("scoping: a foreign app's higher-HLC row on the same node never inflates the channel's coverage", async () => {
    // One applier physically holds rows for apps P and Q (same nodeId,
    // Q's HLC higher), but the channel's namespace store lists only P.
    const appSource = makeMockAppSource("app-p", [
      { name: "test_rows", pkColumns: ["id"] },
    ]);
    const dev = makeClock("device-1");
    const pRow = appRow("app-p", "test_rows", "p1", dev.now());
    const qRow = appRow("app-q", "test_rows", "q1", dev.now()); // higher HLC
    await appSource.applier.apply(pRow);
    await appSource.applier.apply(qRow);

    const cloud = await makeCloud(appSource, false);
    const res = await cloud.transport.exchange({ watermarks: {} });
    expect(serializeHLC(res.responderWatermarks["device-1"]!)).toBe(
      serializeHLC(pRow.timestamp),
    );
  });

  it("a throwing getNodeWatermarks omits its nodes without failing the exchange", async () => {
    const appSource = makeMockAppSource("test-app", [
      { name: "test_rows", pkColumns: ["id"] },
    ]);
    const dev = makeClock("device-1");
    await appSource.applier.apply(appRow("test-app", "test_rows", "r1", dev.now()));
    const throwingApplier: typeof appSource.applier = {
      ...appSource.applier,
      async getNodeWatermarks() {
        throw new Error("boom");
      },
    };
    const cloud = await makeCloud(
      { ...appSource, applier: throwingApplier },
      false,
    );
    const res = await cloud.transport.exchange({ watermarks: {} });
    // Fail-safe direction: the node is merely omitted (→ re-ship next round).
    expect(res.responderWatermarks).toEqual({});
  });
});

describe("responderWatermarks — false-ack and contiguity (Defect C)", () => {
  function failingApplier(
    base: ScanCapableApplier,
    shouldFail: (entry: AppSyncableRowEntry) => boolean,
  ): ScanCapableApplier {
    return {
      ...base,
      async apply(entry) {
        if (shouldFail(entry)) {
          throw new Error(`[test] injected apply failure for ${entry.row?.["id"]}`);
        }
        return base.apply(entry);
      },
    };
  }

  it("an app row that fails to apply is excluded from coverage and re-ships next round", async () => {
    const cloudApp = makeMockAppSource("test-app", [
      { name: "test_rows", pkColumns: ["id"] },
    ]);
    let failing = true;
    const cloud = await makeCloud(
      {
        ...cloudApp,
        applier: failingApplier(cloudApp.applier, () => failing),
      },
      true,
    );
    const device = await makeDevice("device-1", cloud.transport, cloud.storage);
    await device.app.applier.apply(
      appRow("test-app", "test_rows", "r1", device.clock.now()),
    );

    // Round 1: cloud acks the exchange but the apply failed — coverage must
    // not include the row, so the requester's cache stays behind it.
    const r1 = await device.exchange();
    expect(r1.shipped).toBe(1);
    expect(cloudApp.rows.size).toBe(0);
    expect(
      (await device.syncState.getPeerWatermarks())["device-1"],
    ).toBeUndefined();

    // Round 2 (responder healed): the row re-ships and lands.
    failing = false;
    const r2 = await device.exchange();
    expect(r2.shipped).toBe(1);
    expect(cloudApp.rows.size).toBe(1);
    const peer = await device.syncState.getPeerWatermarks();
    expect(peer["device-1"]).toBeDefined();
  });

  it("gap case: a same-node failure halts later rows so full-state MAX can't mask the failed one", async () => {
    const cloudApp = makeMockAppSource("test-app", [
      { name: "test_rows", pkColumns: ["id"] },
    ]);
    let failR1 = true;
    const cloud = await makeCloud(
      {
        ...cloudApp,
        applier: failingApplier(
          cloudApp.applier,
          (e) => failR1 && e.row?.["id"] === "r1",
        ),
      },
      true,
    );
    const device = await makeDevice("device-1", cloud.transport, cloud.storage);
    await device.app.applier.apply(
      appRow("test-app", "test_rows", "r1", device.clock.now()),
    );
    await device.app.applier.apply(
      appRow("test-app", "test_rows", "r2", device.clock.now()),
    );

    // Round 1: r1's apply throws. Without the per-node halt, r2 would land
    // and coverage would report r2's (higher) HLC — permanently masking r1.
    const r1 = await device.exchange();
    expect(r1.shipped).toBe(2);
    expect(cloudApp.rows.size).toBe(0); // r2 must NOT have been applied
    expect(
      (await device.syncState.getPeerWatermarks())["device-1"],
    ).toBeUndefined();

    // Round 2 (healed): both rows re-ship in HLC order and land.
    failR1 = false;
    await device.exchange();
    expect(cloudApp.rows.size).toBe(2);
  });
});

describe("responderWatermarks — peer identity and multi-device", () => {
  it("peer-identity change: push reconciles to the actual responder, both directions", async () => {
    // Local previously synced with some other cloud: its cache claims the
    // peer covers everything. The responder it now talks to holds different
    // data entirely.
    const cloud = await makeCloud();
    const otherDevice = makeClock("other-device");
    const cloudOnly = makeRecord(otherDevice);
    await cloud.db.put(cloudOnly);

    const device = await makeDevice("device-1", cloud.transport, cloud.storage);
    const localRec = makeRecord(device.clock);
    await device.db.put(localRec);
    device.syncState.seedPeer({ "device-1": localRec.updatedAt }); // stale claim

    // Round 1 ships nothing (stale cache) but learns the truth; round 2
    // reconciles. The pull side works from round 1 already.
    await device.exchange();
    await device.exchange();

    expect(await cloud.db.get(localRec.id)).not.toBeNull();
    expect(await device.db.get(cloudOnly.id)).not.toBeNull();
  });

  it("multi-device fan-out against one stateless responder; wipe recovery re-ships pulled foreign-authored records", async () => {
    const cloud = await makeCloud();
    const deviceA = await makeDevice("device-a", cloud.transport, cloud.storage);
    const deviceB = await makeDevice("device-b", cloud.transport, cloud.storage);

    const recA = makeRecord(deviceA.clock);
    await deviceA.db.put(recA);
    const recB = makeRecord(deviceB.clock);
    await deviceB.db.put(recB);

    // Fan-out through the hub: the responder keeps no per-requester state,
    // each device's delta comes purely from its advertised watermarks.
    await deviceA.exchange(); // A → cloud: recA
    await deviceB.exchange(); // B → cloud: recB; B ← cloud: recA
    await deviceA.exchange(); // A ← cloud: recB
    expect(await deviceA.db.get(recB.id)).not.toBeNull();
    expect(await deviceB.db.get(recA.id)).not.toBeNull();

    // Cloud redeploy: only device A syncs afterwards. The author-agnostic
    // outbound scan means A restores recB too — a record it merely pulled
    // from the (now silent) device B.
    cloud.db.clear();
    await deviceA.exchange(); // learns coverage collapsed
    await deviceA.exchange(); // re-ships everything it holds
    expect(await cloud.db.get(recA.id)).not.toBeNull();
    expect(await cloud.db.get(recB.id)).not.toBeNull();
  });
});
