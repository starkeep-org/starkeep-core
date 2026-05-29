import { describe, it, expect } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  compareHLC,
  serializeHLC,
  type HLCTimestamp,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import type {
  AppSyncableApplier,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableRowEntry,
  ScanCapableApplier,
  SyncStateStore,
  Watermarks,
} from "../src/types.js";

// Mirror of `FILE_RECORDS_TABLE` from `@starkeep/shared-space-api` and
// `sync-engine.ts` — kept in sync by hand because importing across the cycle
// isn't possible.
const FILE_RECORDS_TABLE = "_starkeep_sync_records";

interface MockAppRowStore {
  applier: AppSyncableApplier & ScanCapableApplier;
  namespaces: AppSyncableNamespaceStore;
  rows: Map<string, AppSyncableRowEntry>;
}

function makeMockAppSource(
  appId: string,
  tables: { name: string; pkColumns: string[] }[],
): MockAppRowStore {
  // Keyed by `${appId}::${table}::${pk}`.
  const rows = new Map<string, AppSyncableRowEntry>();
  const ns: AppSyncableNamespace = {
    appId,
    tables,
    filesEnabled: tables.some((t) => t.name === FILE_RECORDS_TABLE),
    tableNames: tables.map((t) => t.name),
  };
  const namespaces: AppSyncableNamespaceStore = {
    get: (id) => (id === appId ? ns : null),
    list: () => [ns],
  };
  function pkOf(entry: AppSyncableRowEntry): string {
    const tableInfo = tables.find((t) => t.name === entry.table);
    if (!tableInfo || tableInfo.pkColumns.length === 0) {
      return JSON.stringify(entry.row ?? entry.where ?? {});
    }
    const src = entry.row ?? entry.where ?? {};
    return tableInfo.pkColumns.map((c) => String(src[c])).join("/");
  }
  const applier: AppSyncableApplier & ScanCapableApplier = {
    async apply(entry) {
      const key = `${entry.appId}::${entry.table}::${pkOf(entry)}`;
      const existing = rows.get(key);
      if (existing && compareHLC(existing.timestamp, entry.timestamp) >= 0) {
        return;
      }
      rows.set(key, entry);
    },
    async scanSince(scanAppId, table, sinceHlcStr, options) {
      const floor =
        options?.cursor !== undefined && options.cursor > sinceHlcStr
          ? options.cursor
          : sinceHlcStr;
      const matches: AppSyncableRowEntry[] = [];
      for (const e of rows.values()) {
        if (e.appId !== scanAppId || e.table !== table) continue;
        if (serializeHLC(e.timestamp) > floor) matches.push(e);
      }
      matches.sort((a, b) =>
        serializeHLC(a.timestamp).localeCompare(serializeHLC(b.timestamp)),
      );
      const limit = options?.limit;
      const hasMore = limit !== undefined && matches.length > limit;
      const pageRows = hasMore ? matches.slice(0, limit) : matches;
      const nextCursor =
        hasMore && pageRows.length > 0
          ? serializeHLC(pageRows[pageRows.length - 1]!.timestamp)
          : null;
      return { rows: pageRows, nextCursor, hasMore };
    },
  };
  return { applier, namespaces, rows };
}

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

    const syncState = makeMockSyncState();
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
        // FileRecordsApplier face isn't exercised by exchange(); cast through
        // unknown for the test mock which only implements scan/apply.
        applier: localApp.applier as never,
      },
    });

    const result = await engine.exchange();
    expect(result.shipped).toBe(1);

    // Cloud's AR row landed via the appSyncable apply path...
    const cloudPage = await cloudApp.applier.scanSince(
      "test-app",
      FILE_RECORDS_TABLE,
      "",
    );
    expect(cloudPage.rows).toHaveLength(1);
    expect(cloudPage.rows[0]!.row?.["id"]).toBe("local-photo-1");

    // ...and the blob transferred to the cloud's app-namespace storage.
    expect(await cloudStorage.has(key)).toBe(true);

    // peerWatermark advanced past the AR row's HLC.
    const pwm = await syncState.getPeerWatermarks();
    expect(pwm["local"]).toBeDefined();
    expect(serializeHLC(pwm["local"]!)).toBe(serializeHLC(hlc));
  });

  it("blocks later same-nodeId SR records when an earlier AR row's blob upload fails (cross-stream contiguous prefix)", async () => {
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
    //   t1 — SR record (blob present)        → must ship
    //   t2 — AR row    (blob MISSING locally) → blocked
    //   t3 — SR record (blob present)        → must NOT ship (cross-stream prefix)
    const srEarly = createDataRecord(
      {
        type: "@test/photo",
        ownerId: "u1",
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
        ownerId: "u1",
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

    const syncState = makeMockSyncState();
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

    // SR early ships (blob present, comes first in HLC order).
    expect(await cloudDb.get(srEarly.id)).not.toBeNull();
    // AR row in middle is blocked (its blob can't be pushed).
    const cloudArPage = await cloudApp.applier.scanSince(
      "test-app",
      FILE_RECORDS_TABLE,
      "",
    );
    expect(cloudArPage.rows).toHaveLength(0);
    // SR late MUST NOT ship even though its blob is fine — otherwise the
    // peerWatermark would leapfrog the AR row and lose it forever.
    expect(await cloudDb.get(srLate.id)).toBeNull();

    // peerWatermark sits at srEarly.updatedAt, behind the AR row.
    const pwm = await syncState.getPeerWatermarks();
    expect(serializeHLC(pwm["local"]!)).toBe(serializeHLC(srEarly.updatedAt));

    // Repair: put the missing AR blob locally and re-run. AR ships, then SR late.
    await localStorage.put(arKey, new Uint8Array([2]), {
      contentType: "image/jpeg",
    });
    await engine.exchange();

    const afterPage = await cloudApp.applier.scanSince(
      "test-app",
      FILE_RECORDS_TABLE,
      "",
    );
    expect(afterPage.rows).toHaveLength(1);
    expect(await cloudStorage.has(arKey)).toBe(true);
    expect(await cloudDb.get(srLate.id)).not.toBeNull();
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
    // transfer. Seed 10 rows; pageLimit=3 and scanPageSize=2 force the
    // cursor to traverse multiple scanSince pages per round.
    const ROW_COUNT = 10;
    const localApp = makeMockAppSource("test-app", [
      { name: "items", pkColumns: ["id"] },
    ]);
    const cloudApp = makeMockAppSource("test-app", [
      { name: "items", pkColumns: ["id"] },
    ]);

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

    const syncState = makeMockSyncState();
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
      pageLimit: 3,
      scanPageSize: 2,
    });

    // Drive rounds until convergence (bounded to avoid hangs on regression).
    for (let round = 0; round < 20; round++) {
      const r = await engine.exchange();
      if (r.shipped === 0 && !r.hasMore) break;
    }

    // All rows should have made it to the cloud.
    const cloudPage = await cloudApp.applier.scanSince(
      "test-app",
      "items",
      "",
    );
    expect(cloudPage.rows).toHaveLength(ROW_COUNT);
    const cloudIds = cloudPage.rows
      .map((r) => r.row?.["id"] as string)
      .sort();
    expect(cloudIds).toEqual(
      Array.from({ length: ROW_COUNT }, (_, i) => `row-${i}`).sort(),
    );
  });
});
