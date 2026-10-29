import { describe, expect, it } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  type DataRecord,
  type HLCClock,
  type HLCTimestamp,
  type MetadataRow,
  type RecordLabel,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import type { SyncExchangeRequest, SyncTransport } from "../src/types.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";

/**
 * The change token: an idle exchange answered "unchanged" from the responder's
 * token alone, and every case that must still run in full. See
 * `SyncExchangeRequest.changeToken`.
 */

let wall = 1000;
const makeClock = (nodeId: string): HLCClock =>
  createHLCClock({ nodeId, wallClockFunction: () => wall++ });

let seq = 0;
function record(clock: HLCClock, objectStorageKey = ""): DataRecord {
  return createDataRecord(
    {
      type: "@test/doc",
      originAppId: "test",
      contentHash: `sha256:t${seq++}`,
      objectStorageKey,
      sizeBytes: objectStorageKey ? 1 : 0,
    },
    clock,
  );
}

/**
 * A responder store that replaces its token on every write, as DSQL's storage
 * layer does, and counts the watermark reads an exchange makes.
 */
class HeadedDatabase extends MockDatabaseAdapter {
  token = 0;
  watermarkReads = 0;
  override async put(r: DataRecord): Promise<void> {
    await super.put(r);
    this.token++;
  }
  override async delete(id: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    await super.delete(id, hlc);
    this.token++;
  }
  override async putLabel(label: RecordLabel): Promise<void> {
    await super.putLabel(label);
    this.token++;
  }
  override async putMetadata(type: string, row: MetadataRow): Promise<void> {
    await super.putMetadata(type, row);
    this.token++;
  }
  override async getNodeWatermarks() {
    this.watermarkReads++;
    return super.getNodeWatermarks();
  }
  /** Runs once, inside the next delta scan: a write racing the exchange. */
  duringScan: (() => Promise<void>) | null = null;
  override async querySince(...args: Parameters<MockDatabaseAdapter["querySince"]>) {
    this.watermarkReads++;
    const race = this.duringScan;
    this.duringScan = null;
    if (race) await race();
    return super.querySince(...args);
  }
}

async function makeCloud(options: { head?: boolean } = {}) {
  const db = new HeadedDatabase();
  const storage = new MockObjectStorageAdapter();
  await db.init();
  await storage.init();
  const requests: SyncExchangeRequest[] = [];
  const inner = createInProcessSyncTransport({
    databaseAdapter: db,
    clock: makeClock("cloud"),
    objectStorage: storage,
    ...(options.head === false ? {} : { changeHead: async () => `t${db.token}` }),
  });
  const transport: SyncTransport = {
    async exchange(request) {
      requests.push(request);
      return inner.exchange(request);
    },
  };
  return { db, storage, transport, requests };
}

async function makeDevice(cloud: Awaited<ReturnType<typeof makeCloud>>) {
  const db = new MockDatabaseAdapter();
  const storage = new MockObjectStorageAdapter();
  await db.init();
  await storage.init();
  const syncState = createMemorySyncStateStore();
  const clock = makeClock("device");
  const engine = createSyncEngine({
    localDatabaseAdapter: db,
    localObjectStorage: storage,
    remoteObjectStorage: cloud.storage,
    transport: cloud.transport,
    clock,
    syncState,
  });
  return { db, clock, syncState, exchange: () => engine.exchange() };
}

describe("change token — the responder", () => {
  it("answers an idle exchange from the token without reading any watermark", async () => {
    const cloud = await makeCloud();
    await cloud.db.put(record(makeClock("node-a")));
    const first = await cloud.transport.exchange({ watermarks: {} });
    expect(first.changeToken).toBe("t1");

    cloud.db.watermarkReads = 0;
    const second = await cloud.transport.exchange({
      watermarks: first.responderWatermarks,
      changeToken: first.changeToken!,
    });
    expect(second.unchanged).toBe(true);
    expect(second.records).toEqual([]);
    expect(cloud.db.watermarkReads).toBe(0);
  });

  it("runs in full once anything has been written since the token", async () => {
    const cloud = await makeCloud();
    const first = await cloud.transport.exchange({ watermarks: {} });
    const written = record(makeClock("node-a"));
    await cloud.db.put(written);

    const second = await cloud.transport.exchange({
      watermarks: first.responderWatermarks,
      changeToken: first.changeToken!,
    });
    expect(second.unchanged).toBeUndefined();
    expect(second.records.map((r) => r.id)).toEqual([written.id]);
  });

  it("ships a write that lands between its token read and its data read on the next exchange", async () => {
    // The token is read first, so it predates the racing write: the requester
    // stores a token that no longer matches, and the next exchange runs in
    // full. Read the other way round, the write would be in neither.
    const cloud = await makeCloud();
    const racing = record(makeClock("node-b"));
    const first = await cloud.transport.exchange({ watermarks: {} });
    cloud.db.duringScan = () => cloud.db.put(racing);
    const second = await cloud.transport.exchange({
      watermarks: first.responderWatermarks,
      changeToken: "not-current",
    });
    const third = await cloud.transport.exchange({
      watermarks: second.responderWatermarks,
      changeToken: second.changeToken!,
    });
    const shipped = [...second.records, ...third.records].map((r) => r.id);
    expect(shipped).toContain(racing.id);
    expect(third.unchanged).toBeUndefined();
  });

  it("reads the token after applying the request's own rows", async () => {
    // A push replaces the token as it applies, so a token read before the
    // apply would be stale at once and cost every pushing device a second
    // full exchange.
    const cloud = await makeCloud();
    const pushed = record(makeClock("device"));
    const res = await cloud.transport.exchange({ watermarks: {}, records: [pushed] });
    expect(res.changeToken).toBe(`t${cloud.db.token}`);
  });

  it("issues no token while it leaves rows behind", async () => {
    const cloud = await makeCloud();
    const author = makeClock("node-a");
    await cloud.db.put(record(author));
    await cloud.db.put(record(author));
    const res = await cloud.transport.exchange({ watermarks: {}, limit: 1 });
    expect(res.hasMore).toBe(true);
    expect(res.changeToken).toBeUndefined();
  });

  it("issues no token while a file is still to arrive, and one once it has", async () => {
    // An upload lands without a row write, so the token would not move for
    // it; only the walk can raise the bytes watermark.
    const cloud = await makeCloud();
    const withFile = record(makeClock("node-a"), "shared/test/abc");
    await cloud.db.put(withFile);
    const waiting = await cloud.transport.exchange({ watermarks: {} });
    expect(waiting.changeToken).toBeUndefined();

    await cloud.storage.put("shared/test/abc", new Uint8Array([1]));
    const landed = await cloud.transport.exchange({ watermarks: waiting.responderWatermarks });
    expect(landed.changeToken).toBe(`t${cloud.db.token}`);
  });

  it("runs in full when the token will not read", async () => {
    const cloud = await makeCloud();
    const inner = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: makeClock("cloud"),
      objectStorage: cloud.storage,
      changeHead: async () => {
        throw new Error("no such table");
      },
    });
    const res = await inner.exchange({ watermarks: {}, changeToken: "t0" });
    expect(res.unchanged).toBeUndefined();
    expect(res.changeToken).toBeUndefined();
  });

  it("never answers unchanged without a head to compare against", async () => {
    const cloud = await makeCloud({ head: false });
    const res = await cloud.transport.exchange({ watermarks: {}, changeToken: "t0" });
    expect(res.unchanged).toBeUndefined();
    expect(res.changeToken).toBeUndefined();
  });
});

describe("change token — the requester", () => {
  it("echoes the token on an idle round and keeps the peer watermarks it stored with it", async () => {
    const cloud = await makeCloud();
    const pulled = record(makeClock("node-a"));
    await cloud.db.put(pulled);
    const device = await makeDevice(cloud);

    await device.exchange();
    const peer = await device.syncState.getPeerWatermarks();
    expect(Object.keys(peer)).toEqual(["node-a"]);
    expect(await device.syncState.getChangeToken!()).toBe("t1");

    cloud.db.watermarkReads = 0;
    await device.exchange();
    expect(cloud.requests.at(-1)!.changeToken).toBe("t1");
    expect(cloud.db.watermarkReads).toBe(0);
    expect(await device.syncState.getPeerWatermarks()).toEqual(peer);
    expect(await device.db.get(pulled.id)).not.toBeNull();
  });

  it("sends no token on a round that pushes", async () => {
    const cloud = await makeCloud();
    const device = await makeDevice(cloud);
    await device.exchange();
    expect(await device.syncState.getChangeToken!()).not.toBeNull();

    await device.db.put(record(device.clock));
    await device.exchange();
    expect(cloud.requests.at(-1)!.changeToken).toBeUndefined();
    expect(cloud.requests.at(-1)!.records).toHaveLength(1);
  });

  it("sends no token while a repair floor is outstanding", async () => {
    const cloud = await makeCloud();
    await cloud.db.put(record(makeClock("node-a")));
    const device = await makeDevice(cloud);
    await device.exchange();
    const peer = await device.syncState.getPeerWatermarks();

    await device.syncState.setInboundFloors({ "node-a": { ...peer["node-a"]!, wallTime: 0 } });
    await device.exchange();
    expect(cloud.requests.at(-1)!.changeToken).toBeUndefined();
  });

  it("pulls a row written after its token on the next round", async () => {
    const cloud = await makeCloud();
    const device = await makeDevice(cloud);
    await device.exchange();

    const later = record(makeClock("node-b"));
    await cloud.db.put(later);
    await device.exchange();
    expect(await device.db.get(later.id)).not.toBeNull();
    expect(await device.syncState.getChangeToken!()).toBe(`t${cloud.db.token}`);
  });

  it("stores no token from a reply that left rows behind", async () => {
    const cloud = await makeCloud();
    const author = makeClock("node-a");
    for (let i = 0; i < 3; i++) await cloud.db.put(record(author));
    const db = new MockDatabaseAdapter();
    const storage = new MockObjectStorageAdapter();
    await db.init();
    await storage.init();
    const syncState = createMemorySyncStateStore();
    const engine = createSyncEngine({
      localDatabaseAdapter: db,
      localObjectStorage: storage,
      remoteObjectStorage: cloud.storage,
      transport: cloud.transport,
      clock: makeClock("device"),
      syncState,
      maxItems: 1,
    });
    await engine.exchange();
    expect(await syncState.getChangeToken!()).toBeNull();
  });

  it("does not believe an unchanged reply to a round that sent no token", async () => {
    const device = await makeDevice(await makeCloud());
    const peer = { "node-a": makeClock("node-a").now() };
    await device.syncState.setPeerWatermarks(peer);
    const liar: SyncTransport = {
      async exchange() {
        return {
          records: [],
          labels: [],
          appSyncableRows: [],
          responderWatermarks: {},
          hasMore: false,
          unchanged: true,
        };
      },
    };
    const engine = createSyncEngine({
      localDatabaseAdapter: device.db,
      localObjectStorage: new MockObjectStorageAdapter(),
      remoteObjectStorage: new MockObjectStorageAdapter(),
      transport: liar,
      clock: device.clock,
      syncState: device.syncState,
    });
    await engine.exchange();
    expect(await device.syncState.getPeerWatermarks()).toEqual({});
  });
});
