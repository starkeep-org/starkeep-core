import { describe, it, expect } from "vitest";
import {
  createHLCClock,
  createDataRecord,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import type { SyncStateStore, Watermarks } from "../src/types.js";

function makeMockSyncState(): SyncStateStore {
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

describe("version-vector exchange", () => {
  it("round-trips local creates to the cloud and pulls cloud-created records back", async () => {
    let time = 1000;
    const localClock = createHLCClock({
      nodeId: "local",
      wallClockFunction: () => time++,
    });
    const cloudClock = createHLCClock({
      nodeId: "cloud",
      wallClockFunction: () => time++,
    });

    const localDb = new MockDatabaseAdapter();
    const cloudDb = new MockDatabaseAdapter();
    const localStorage = new MockObjectStorageAdapter();
    const cloudStorage = new MockObjectStorageAdapter();

    await localDb.init();
    await cloudDb.init();
    await localStorage.init();
    await cloudStorage.init();

    // Local writes a record directly (bypassing SDK) — equivalent to what the
    // SDK would do under the exchange protocol.
    const localRecord = createDataRecord(
      {
        type: "@test/photo",
        ownerId: "u1",
        originAppId: "test",
        contentHash: "sha256:abc",
        objectStorageKey: "shared/@test/photo/ab/abc",
        mimeType: "image/jpeg",
        sizeBytes: 100,
      },
      localClock,
    );
    await localDb.put(localRecord);
    // Blob present locally — exchange will push it as a prerequisite of
    // shipping the metadata.
    await localStorage.put(localRecord.objectStorageKey, new Uint8Array([1, 2, 3]), {
      contentType: localRecord.mimeType,
    });

    // Cloud already holds a record originated on the cloud (e.g. legacy data).
    const cloudRecord = createDataRecord(
      {
        type: "@test/photo",
        ownerId: "u2",
        originAppId: "test",
        contentHash: "sha256:def",
        objectStorageKey: "shared/@test/photo/de/def",
        mimeType: "image/jpeg",
        sizeBytes: 200,
      },
      cloudClock,
    );
    await cloudDb.put(cloudRecord);
    await cloudStorage.put(cloudRecord.objectStorageKey, new Uint8Array([4, 5, 6]), {
      contentType: cloudRecord.mimeType,
    });

    const syncState = makeMockSyncState();
    const cloudTransport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      objectStorage: cloudStorage,
    });

    const engine = createSyncEngine({
      localDatabaseAdapter: localDb,
      localObjectStorage: localStorage,
      remoteObjectStorage: cloudStorage,
      transport: cloudTransport,
      clock: localClock,
      syncState,
    });

    // First exchange: local ships its record (peer watermark = {}); cloud
    // ships its record. Both sides should now hold both records.
    const result = await engine.exchange();
    expect(result.applied).toBe(1);
    expect(result.shipped).toBe(1);

    const cloudHasLocal = await cloudDb.get(localRecord.id);
    expect(cloudHasLocal).not.toBeNull();
    expect(cloudHasLocal!.contentHash).toBe("sha256:abc");

    const localHasCloud = await localDb.get(cloudRecord.id);
    expect(localHasCloud).not.toBeNull();
    expect(localHasCloud!.contentHash).toBe("sha256:def");

    // Watermarks: local has seen the cloud record → watermarks["cloud"] set.
    const wm = await syncState.getWatermarks();
    expect(wm["cloud"]).toBeDefined();
    expect(wm["cloud"]).toEqual(cloudRecord.updatedAt);

    // Peer watermarks: advanced past every record we shipped (here, the one
    // local-originated record).
    const pwm = await syncState.getPeerWatermarks();
    expect(pwm["local"]).toBeDefined();
    expect(pwm["local"]).toEqual(localRecord.updatedAt);

    // Both sides should hold both blobs after the exchange.
    expect(await cloudStorage.has(localRecord.objectStorageKey)).toBe(true);
    expect(await localStorage.has(cloudRecord.objectStorageKey)).toBe(true);

    // Second exchange should be a no-op (no new records on either side).
    const result2 = await engine.exchange();
    expect(result2.applied).toBe(0);
    expect(result2.shipped).toBe(0);
  });

  it("propagates tombstones via deletedAt in the snapshot", async () => {
    let time = 1000;
    const localClock = createHLCClock({
      nodeId: "local",
      wallClockFunction: () => time++,
    });
    const cloudClock = createHLCClock({
      nodeId: "cloud",
      wallClockFunction: () => time++,
    });

    const localDb = new MockDatabaseAdapter();
    const cloudDb = new MockDatabaseAdapter();
    const localStorage = new MockObjectStorageAdapter();
    const cloudStorage = new MockObjectStorageAdapter();
    await localDb.init();
    await cloudDb.init();
    await localStorage.init();
    await cloudStorage.init();

    const record = createDataRecord(
      {
        type: "@test/photo",
        ownerId: "u1",
        originAppId: "test",
        contentHash: "sha256:tombstone",
        objectStorageKey: "shared/@test/photo/to/tombstone",
        mimeType: "image/jpeg",
        sizeBytes: 100,
      },
      localClock,
    );
    await localDb.put(record);
    await cloudDb.put(record);
    await localStorage.put(record.objectStorageKey, new Uint8Array([1]), {
      contentType: record.mimeType,
    });
    await cloudStorage.put(record.objectStorageKey, new Uint8Array([1]), {
      contentType: record.mimeType,
    });

    // Local soft-deletes via adapter.delete.
    await localDb.delete(record.id, localClock.now());

    const syncState = makeMockSyncState();
    const cloudTransport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      objectStorage: cloudStorage,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: localDb,
      localObjectStorage: localStorage,
      remoteObjectStorage: cloudStorage,
      transport: cloudTransport,
      clock: localClock,
      syncState,
    });

    await engine.exchange();

    const cloudCopy = await cloudDb.get(record.id);
    expect(cloudCopy).not.toBeNull();
    expect(cloudCopy!.deletedAt).not.toBeNull();
  });

  it("blob upload failure keeps peerWatermarks behind the unsent record (auto-retry)", async () => {
    let time = 1000;
    const localClock = createHLCClock({
      nodeId: "local",
      wallClockFunction: () => time++,
    });
    const cloudClock = createHLCClock({
      nodeId: "cloud",
      wallClockFunction: () => time++,
    });

    const localDb = new MockDatabaseAdapter();
    const cloudDb = new MockDatabaseAdapter();
    const localStorage = new MockObjectStorageAdapter();
    const cloudStorage = new MockObjectStorageAdapter();
    await localDb.init();
    await cloudDb.init();
    await localStorage.init();
    await cloudStorage.init();

    // Three local records in HLC order: r1, r2, r3. r1 + r3 have local blobs;
    // r2's blob is missing locally → transferFile will return false → it's
    // excluded from the outbound batch. Because we process per-nodeId in HLC
    // order with a contiguous-prefix rule, r3 must NOT cause peerWatermarks
    // to leapfrog r2 — otherwise r2 would be lost.
    const records: Array<ReturnType<typeof createDataRecord>> = [];
    for (let i = 0; i < 3; i++) {
      const r = createDataRecord(
        {
          type: "@test/photo",
          ownerId: "u1",
          originAppId: "test",
          contentHash: `sha256:r${i}`,
          objectStorageKey: `shared/@test/photo/r/r${i}`,
          mimeType: "image/jpeg",
          sizeBytes: 100,
        },
        localClock,
      );
      records.push(r);
      await localDb.put(r);
    }
    // Put blob bytes for r1 and r3 only — r2's blob is "lost" locally.
    await localStorage.put(records[0]!.objectStorageKey, new Uint8Array([1]), {
      contentType: "image/jpeg",
    });
    await localStorage.put(records[2]!.objectStorageKey, new Uint8Array([3]), {
      contentType: "image/jpeg",
    });

    const syncState = makeMockSyncState();
    const cloudTransport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      objectStorage: cloudStorage,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: localDb,
      localObjectStorage: localStorage,
      remoteObjectStorage: cloudStorage,
      transport: cloudTransport,
      clock: localClock,
      syncState,
    });

    await engine.exchange();

    // Strict contiguous-prefix shipping: r0 ships (blob present), r1 fails
    // (no blob), r2 is NOT shipped this round even though its blob is
    // present — otherwise we'd create a gap on cloud that misleads other
    // clients into advancing past r2 and never receiving r1.
    expect(await cloudDb.get(records[0]!.id)).not.toBeNull();
    expect(await cloudDb.get(records[1]!.id)).toBeNull();
    expect(await cloudDb.get(records[2]!.id)).toBeNull();

    const pwm = await syncState.getPeerWatermarks();
    expect(pwm["local"]).toEqual(records[0]!.updatedAt);

    // Repair r1's blob locally and re-run. Now r1 ships, then r2 ships.
    await localStorage.put(records[1]!.objectStorageKey, new Uint8Array([2]), {
      contentType: "image/jpeg",
    });
    await engine.exchange();
    expect(await cloudDb.get(records[1]!.id)).not.toBeNull();
    expect(await cloudDb.get(records[2]!.id)).not.toBeNull();
  });

  it("first-round exchange with empty peer watermarks ships all records (cloud-reinstall recovery)", async () => {
    let time = 1000;
    const localClock = createHLCClock({
      nodeId: "local",
      wallClockFunction: () => time++,
    });
    const cloudClock = createHLCClock({
      nodeId: "cloud",
      wallClockFunction: () => time++,
    });

    const localDb = new MockDatabaseAdapter();
    const cloudDb = new MockDatabaseAdapter();
    const localStorage = new MockObjectStorageAdapter();
    const cloudStorage = new MockObjectStorageAdapter();
    await localDb.init();
    await cloudDb.init();
    await localStorage.init();
    await cloudStorage.init();

    // Local has three records, cloud is empty (post-reinstall).
    for (let i = 0; i < 3; i++) {
      const r = createDataRecord(
        {
          type: "@test/photo",
          ownerId: "u1",
          originAppId: "test",
          contentHash: `sha256:r${i}`,
          objectStorageKey: `shared/@test/photo/r/r${i}`,
          mimeType: "image/jpeg",
          sizeBytes: 100,
        },
        localClock,
      );
      await localDb.put(r);
      await localStorage.put(r.objectStorageKey, new Uint8Array([i]), {
        contentType: r.mimeType,
      });
    }

    const syncState = makeMockSyncState();
    const cloudTransport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      objectStorage: cloudStorage,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: localDb,
      localObjectStorage: localStorage,
      remoteObjectStorage: cloudStorage,
      transport: cloudTransport,
      clock: localClock,
      syncState,
    });

    const result = await engine.exchange();
    expect(result.shipped).toBe(3);
    expect(result.applied).toBe(0);
    expect(cloudDb.size).toBe(3);
  });
});
