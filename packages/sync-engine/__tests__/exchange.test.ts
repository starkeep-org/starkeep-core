import {
  mergeDigestBuckets,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DigestBucket,
} from "@starkeep/storage-adapter";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { describe, it, expect } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  compareHLC,
  serializeHLC,
  type HLCTimestamp,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, MockObjectStorageAdapter } from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import type { SyncStateStore, Watermarks } from "../src/types.js";
// The shared mock, not a private copy. This file had its own, and two mocks of
// one contract is how they end up disagreeing with each other and with the SQL
// appliers — see `mock-app-source.ts` and the conformance suite.
import {
  makeMockAppSource,
  FILE_RECORDS_TABLE,
  type MockAppRowStore,
} from "./sync-test-harness/mock-app-source.js";

function fileRecordRow(
  id: string,
  key: string,
  hash: string,
  hlc: HLCTimestamp,
  mimeType = "image/jpeg",
  sizeBytes = 100,
): Record<string, unknown> {
  const hlcStr = serializeHLC(hlc);
  return {
    id,
    object_storage_key: key,
    content_hash: hash,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    original_filename: null,
    origin_app_id: "test-app",
    created_at: hlcStr,
    updated_at: hlcStr,
    deleted_at: null,
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
      contentType: localRecord.mimeType ?? undefined,
    });

    // Cloud already holds a record originated on the cloud (e.g. legacy data).
    const cloudRecord = createDataRecord(
      {
        type: "@test/photo",
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
      contentType: cloudRecord.mimeType ?? undefined,
    });

    const syncState = createMemorySyncStateStore();
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

    // Both sides hold both blobs once the uploader has run: downloads move in
    // the round, uploads beside it.
    await engine.uploader.drain();
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
      contentType: record.mimeType ?? undefined,
    });
    await cloudStorage.put(record.objectStorageKey, new Uint8Array([1]), {
      contentType: record.mimeType ?? undefined,
    });

    // Local soft-deletes via adapter.delete.
    await localDb.delete(record.id, localClock.now());

    const syncState = createMemorySyncStateStore();
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

  it("a file missing locally holds the peer's bytes watermark, not its rows watermark, and uploads once it exists", async () => {
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

    const syncState = createMemorySyncStateStore();
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
    await engine.uploader.drain();

    // Every row ships; the files this node holds upload, r2's included.
    for (const record of records) expect(await cloudDb.get(record.id)).not.toBeNull();
    expect(await cloudStorage.has(records[0]!.objectStorageKey)).toBe(true);
    expect(await cloudStorage.has(records[1]!.objectStorageKey)).toBe(false);
    expect(await cloudStorage.has(records[2]!.objectStorageKey)).toBe(true);

    // The cloud reports its bytes watermark on the next exchange: through r0,
    // stopping at r1's missing file, while its rows watermark covers r2.
    await engine.exchange();
    expect((await syncState.getPeerWatermarks())["local"]).toEqual(records[2]!.updatedAt);
    expect((await syncState.getPeerByteWatermarks())?.["local"]).toEqual(records[0]!.updatedAt);

    // The file turns up locally. The next round uploads it, because the
    // cloud's bytes watermark still says it is owed.
    await localStorage.put(records[1]!.objectStorageKey, new Uint8Array([2]), {
      contentType: "image/jpeg",
    });
    await engine.exchange();
    await engine.uploader.drain();
    expect(engine.uploader.stats().sent.count).toBe(3);
    expect(await cloudStorage.has(records[1]!.objectStorageKey)).toBe(true);
    await engine.exchange();
    expect((await syncState.getPeerByteWatermarks())?.["local"]).toEqual(records[2]!.updatedAt);
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
        contentType: r.mimeType ?? undefined,
      });
    }

    const syncState = createMemorySyncStateStore();
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

  it("ships an app-record (AR) row's blob through to the cloud's app-namespace storage", async () => {
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

    const localApp = makeMockAppSource("test-app", [
      { name: FILE_RECORDS_TABLE, pkColumns: ["id"] },
    ]);
    const cloudApp = makeMockAppSource("test-app", [
      { name: FILE_RECORDS_TABLE, pkColumns: ["id"] },
    ]);

    // Local writes an AR row with a blob into the app's prefixed namespace.
    const hlc = localClock.now();
    const key = "app/test-app/photos/local-photo-1";
    await localApp.applier.apply({
      timestamp: hlc,
      appId: "test-app",
      table: FILE_RECORDS_TABLE,
      op: "insert",
      row: fileRecordRow("local-photo-1", key, "sha256:abc", hlc),
    });
    await localStorage.put(key, new Uint8Array([7, 8, 9]), {
      contentType: "image/jpeg",
    });

    const syncState = createMemorySyncStateStore();
    const cloudTransport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      objectStorage: cloudStorage,
      appSyncableSource: {
        namespaces: cloudApp.namespaces,
        applier: cloudApp.applier,
      },
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: localDb,
      localObjectStorage: localStorage,
      remoteObjectStorage: cloudStorage,
      transport: cloudTransport,
      clock: localClock,
      syncState,
      appSyncableSource: {
        namespaces: localApp.namespaces,
        applier: localApp.applier,
      },
    });

    const result = await engine.exchange();
    expect(result.shipped).toBe(1);
    await engine.uploader.drain();

    // Cloud's AR row landed via the appSyncable apply path...
    const cloudPage = await cloudApp.applier.scanSince("test-app", FILE_RECORDS_TABLE, {}, 1000);
    expect(cloudPage.rows).toHaveLength(1);
    expect(cloudPage.rows[0]!.row?.["id"]).toBe("local-photo-1");

    // ...and the blob transferred to the cloud's app-namespace storage.
    expect(await cloudStorage.has(key)).toBe(true);

    // peerWatermark advanced past the AR row's HLC.
    const pwm = await syncState.getPeerWatermarks();
    expect(pwm["local"]).toBeDefined();
    expect(serializeHLC(pwm["local"]!)).toBe(serializeHLC(hlc));
  });

  it("holds the bytes watermark at an AR row whose file is missing, across streams, while every row ships", async () => {
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

    const localApp = makeMockAppSource("test-app", [
      { name: FILE_RECORDS_TABLE, pkColumns: ["id"] },
    ]);
    const cloudApp = makeMockAppSource("test-app", [
      { name: FILE_RECORDS_TABLE, pkColumns: ["id"] },
    ]);

    // HLC order on nodeId="local":
    //   t1 — SR record (blob present)
    //   t2 — AR row    (blob MISSING locally)
    //   t3 — SR record (blob present)
    // Every row ships. The cloud's bytes watermark must stop at t1 across
    // both streams, or the AR file's upload would be forgotten.
    const srEarly = createDataRecord(
      {
        type: "@test/photo",
        originAppId: "test",
        contentHash: "sha256:sr-early",
        objectStorageKey: "shared/@test/photo/sr/early",
        mimeType: "image/jpeg",
        sizeBytes: 100,
      },
      localClock,
    );
    await localDb.put(srEarly);
    await localStorage.put(srEarly.objectStorageKey, new Uint8Array([1]), {
      contentType: "image/jpeg",
    });

    const arHlc = localClock.now();
    const arKey = "app/test-app/missing-blob";
    await localApp.applier.apply({
      timestamp: arHlc,
      appId: "test-app",
      table: FILE_RECORDS_TABLE,
      op: "insert",
      row: fileRecordRow("ar-mid", arKey, "sha256:ar-mid", arHlc),
    });
    // Deliberately do NOT put the AR blob locally — transferFile will return
    // false because the source doesn't have it.

    const srLate = createDataRecord(
      {
        type: "@test/photo",
        originAppId: "test",
        contentHash: "sha256:sr-late",
        objectStorageKey: "shared/@test/photo/sr/late",
        mimeType: "image/jpeg",
        sizeBytes: 100,
      },
      localClock,
    );
    await localDb.put(srLate);
    await localStorage.put(srLate.objectStorageKey, new Uint8Array([3]), {
      contentType: "image/jpeg",
    });

    const syncState = createMemorySyncStateStore();
    const cloudTransport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      objectStorage: cloudStorage,
      appSyncableSource: {
        namespaces: cloudApp.namespaces,
        applier: cloudApp.applier,
      },
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: localDb,
      localObjectStorage: localStorage,
      remoteObjectStorage: cloudStorage,
      transport: cloudTransport,
      clock: localClock,
      syncState,
      appSyncableSource: {
        namespaces: localApp.namespaces,
        applier: localApp.applier as never,
      },
    });

    await engine.exchange();
    await engine.uploader.drain();
    await engine.exchange();

    // Every row ships, the AR row included.
    expect(await cloudDb.get(srEarly.id)).not.toBeNull();
    const cloudArPage = await cloudApp.applier.scanSince("test-app", FILE_RECORDS_TABLE, {}, 1000);
    expect(cloudArPage.rows).toHaveLength(1);
    expect(await cloudDb.get(srLate.id)).not.toBeNull();
    expect(await cloudStorage.has(srLate.objectStorageKey)).toBe(true);
    expect(await cloudStorage.has(arKey)).toBe(false);

    // The bytes watermark sits at srEarly, behind the AR row, across streams.
    const bytes = await syncState.getPeerByteWatermarks();
    expect(serializeHLC(bytes!["local"]!)).toBe(serializeHLC(srEarly.updatedAt));

    // Repair: put the missing AR blob locally. The next round uploads it and
    // the one after reports the bytes watermark past srLate.
    await localStorage.put(arKey, new Uint8Array([2]), {
      contentType: "image/jpeg",
    });
    await engine.exchange();
    await engine.uploader.drain();
    await engine.exchange();
    expect(await cloudStorage.has(arKey)).toBe(true);
    const after = await syncState.getPeerByteWatermarks();
    expect(serializeHLC(after!["local"]!)).toBe(serializeHLC(srLate.updatedAt));
  });

  it("AR/AW pagination: backlog exceeds a single scanSince page — cursor advances across pages so no rows strand", async () => {
    // Mirror of the SR regression test in s6-pagination.test.ts, exercising
    // the AR/AW outbound scan loop. With the pre-cursor code (`scanSince`
    // returned everything in one go), this passed trivially because the
    // entire table fit in memory; with cursor pagination, the engine has to
    // advance across multiple pages within a single round. If the cursor
    // logic regresses, rows past page 1 strand forever.
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

    // Plain AW table (no blobs) so we can focus on row pagination, not blob
    // transfer. Seed 10 rows; maxItems=3 forces the
    // cursor to traverse multiple scanSince pages per round.
    const ROW_COUNT = 10;
    const localApp = makeMockAppSource("test-app", [{ name: "items", pkColumns: ["id"] }]);
    const cloudApp = makeMockAppSource("test-app", [{ name: "items", pkColumns: ["id"] }]);

    for (let i = 0; i < ROW_COUNT; i++) {
      const hlc = localClock.now();
      const hlcStr = serializeHLC(hlc);
      await localApp.applier.apply({
        timestamp: hlc,
        appId: "test-app",
        table: "items",
        op: "insert",
        row: {
          id: `row-${i}`,
          payload: `v${i}`,
          created_at: hlcStr,
          updated_at: hlcStr,
          deleted_at: null,
        },
      });
    }

    const syncState = createMemorySyncStateStore();
    const cloudTransport = createInProcessSyncTransport({
      databaseAdapter: cloudDb,
      clock: cloudClock,
      objectStorage: cloudStorage,
      appSyncableSource: {
        namespaces: cloudApp.namespaces,
        applier: cloudApp.applier,
      },
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: localDb,
      localObjectStorage: localStorage,
      remoteObjectStorage: cloudStorage,
      transport: cloudTransport,
      clock: localClock,
      syncState,
      appSyncableSource: {
        namespaces: localApp.namespaces,
        applier: localApp.applier as never,
      },
      maxItems: 3,
    });

    // Drive rounds until convergence (bounded to avoid hangs on regression).
    for (let round = 0; round < 20; round++) {
      const r = await engine.exchange();
      if (r.shipped === 0 && !r.hasMore) break;
    }

    // All rows should have made it to the cloud.
    const cloudPage = await cloudApp.applier.scanSince("test-app", "items", {}, 1000);
    expect(cloudPage.rows).toHaveLength(ROW_COUNT);
    const cloudIds = cloudPage.rows.map((r) => r.row?.["id"] as string).sort();
    expect(cloudIds).toEqual(Array.from({ length: ROW_COUNT }, (_, i) => `row-${i}`).sort());
  });
});
