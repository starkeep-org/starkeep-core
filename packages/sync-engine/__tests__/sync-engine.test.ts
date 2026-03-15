import { describe, it, expect, vi } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  type StarkeepId,
  type HLCTimestamp,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createChangeLog } from "../src/change-log.js";
import { resolveConflict } from "../src/conflict-resolver.js";
import { createChangeNotifier } from "../src/change-notifier.js";
import { createFileSyncEngine } from "../src/file-sync-engine.js";
import type { ChangeLogEntry } from "../src/types.js";

function createTestSetup() {
  let time = 1000;
  const localClock = createHLCClock({
    nodeId: "local-node",
    wallClockFunction: () => time++,
  });
  const remoteClock = createHLCClock({
    nodeId: "remote-node",
    wallClockFunction: () => time++,
  });

  const localDatabase = new MockDatabaseAdapter();
  const remoteDatabase = new MockDatabaseAdapter();
  const localObjectStorage = new MockObjectStorageAdapter();
  const remoteObjectStorage = new MockObjectStorageAdapter();

  const syncEngine = createSyncEngine({
    localDatabaseAdapter: localDatabase,
    remoteDatabaseAdapter: remoteDatabase,
    localObjectStorage,
    remoteObjectStorage,
    clock: localClock,
  });

  return {
    localClock,
    remoteClock,
    localDatabase,
    remoteDatabase,
    localObjectStorage,
    remoteObjectStorage,
    syncEngine,
  };
}

describe("createChangeLog", () => {
  it("should append and retrieve entries", async () => {
    const changeLog = createChangeLog();
    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => 1000,
    });
    const record = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      clock,
    );

    const entry = await changeLog.append({
      recordId: record.id,
      operation: "create",
      timestamp: clock.now(),
      recordSnapshot: record,
    });

    expect(entry.changeId).toBeDefined();
    expect(entry.operation).toBe("create");
  });

  it("should get changes since a timestamp", async () => {
    const changeLog = createChangeLog();
    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => 1000,
    });

    const record1 = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      clock,
    );
    const earlyTimestamp: HLCTimestamp = {
      wallTime: 1000,
      counter: 0,
      nodeId: "test",
    };

    await changeLog.append({
      recordId: record1.id,
      operation: "create",
      timestamp: earlyTimestamp,
      recordSnapshot: record1,
    });

    const midpoint: HLCTimestamp = {
      wallTime: 2000,
      counter: 0,
      nodeId: "test",
    };

    const record2 = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      clock,
    );
    const lateTimestamp: HLCTimestamp = {
      wallTime: 3000,
      counter: 0,
      nodeId: "test",
    };

    await changeLog.append({
      recordId: record2.id,
      operation: "create",
      timestamp: lateTimestamp,
      recordSnapshot: record2,
    });

    const changes = await changeLog.getChangesSince(midpoint);
    expect(changes).toHaveLength(1);
  });

  it("should get latest timestamp", async () => {
    const changeLog = createChangeLog();
    let time = 1000;
    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => time++,
    });

    expect(await changeLog.getLatestTimestamp()).toBeNull();

    const record = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      clock,
    );
    await changeLog.append({
      recordId: record.id,
      operation: "create",
      timestamp: clock.now(),
      recordSnapshot: record,
    });

    const latest = await changeLog.getLatestTimestamp();
    expect(latest).not.toBeNull();
  });

  it("should prune old entries", async () => {
    const changeLog = createChangeLog();
    let time = 1000;
    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => time++,
    });

    const record1 = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      clock,
    );
    await changeLog.append({
      recordId: record1.id,
      operation: "create",
      timestamp: { wallTime: 1000, counter: 0, nodeId: "test" },
      recordSnapshot: record1,
    });

    const record2 = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      clock,
    );
    await changeLog.append({
      recordId: record2.id,
      operation: "create",
      timestamp: { wallTime: 2000, counter: 0, nodeId: "test" },
      recordSnapshot: record2,
    });

    const pruned = await changeLog.prune({
      wallTime: 1500,
      counter: 0,
      nodeId: "test",
    });
    expect(pruned).toBe(1);
  });
});

describe("resolveConflict", () => {
  it("should resolve in favor of later HLC timestamp", () => {
    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => 1000,
    });
    const record = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      clock,
    );

    const localRecord = {
      ...record,
      updatedAt: { wallTime: 2000, counter: 0, nodeId: "local" },
    };
    const remoteRecord = {
      ...record,
      updatedAt: { wallTime: 1000, counter: 0, nodeId: "remote" },
    };

    const localChange: ChangeLogEntry = {
      changeId: "change-1" as StarkeepId,
      recordId: record.id,
      operation: "update",
      timestamp: localRecord.updatedAt,
      recordSnapshot: localRecord,
    };
    const remoteChange: ChangeLogEntry = {
      changeId: "change-2" as StarkeepId,
      recordId: record.id,
      operation: "update",
      timestamp: remoteRecord.updatedAt,
      recordSnapshot: remoteRecord,
    };

    const resolution = resolveConflict(localChange, remoteChange);
    expect(resolution.winner).toBe("local");
  });

  it("should tie-break by nodeId", () => {
    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => 1000,
    });
    const record = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      clock,
    );

    const sameTimestamp = { wallTime: 1000, counter: 0, nodeId: "" };
    const localRecord = {
      ...record,
      updatedAt: { ...sameTimestamp, nodeId: "node-b" },
    };
    const remoteRecord = {
      ...record,
      updatedAt: { ...sameTimestamp, nodeId: "node-a" },
    };

    const localChange: ChangeLogEntry = {
      changeId: "change-1" as StarkeepId,
      recordId: record.id,
      operation: "update",
      timestamp: localRecord.updatedAt,
      recordSnapshot: localRecord,
    };
    const remoteChange: ChangeLogEntry = {
      changeId: "change-2" as StarkeepId,
      recordId: record.id,
      operation: "update",
      timestamp: remoteRecord.updatedAt,
      recordSnapshot: remoteRecord,
    };

    const resolution = resolveConflict(localChange, remoteChange);
    expect(resolution.winner).toBe("local");
  });
});

describe("createChangeNotifier", () => {
  it("should notify subscribers", () => {
    const notifier = createChangeNotifier();
    const listener = vi.fn();

    notifier.subscribe(listener);
    notifier.emit({
      eventType: "local-data-synced",
      recordIds: ["record-1" as StarkeepId],
      timestamp: { wallTime: 1000, counter: 0, nodeId: "test" },
    });

    expect(listener).toHaveBeenCalledOnce();
  });

  it("should unsubscribe correctly", () => {
    const notifier = createChangeNotifier();
    const listener = vi.fn();

    const unsubscribe = notifier.subscribe(listener);
    unsubscribe();

    notifier.emit({
      eventType: "local-data-synced",
      recordIds: [],
      timestamp: { wallTime: 1000, counter: 0, nodeId: "test" },
    });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createFileSyncEngine", () => {
  it("should identify files to push", async () => {
    const fileSyncEngine = createFileSyncEngine();
    const localStorage = new MockObjectStorageAdapter();
    const remoteStorage = new MockObjectStorageAdapter();

    await localStorage.init();
    await remoteStorage.init();
    await localStorage.put("photo-1.jpg", Buffer.from("data"));

    const toPush = await fileSyncEngine.getFilesToPush(
      localStorage,
      remoteStorage,
      ["photo-1.jpg"],
    );

    expect(toPush).toHaveLength(1);
    expect(toPush[0].objectStorageKey).toBe("photo-1.jpg");
  });

  it("should transfer files between storages", async () => {
    const fileSyncEngine = createFileSyncEngine();
    const localStorage = new MockObjectStorageAdapter();
    const remoteStorage = new MockObjectStorageAdapter();

    await localStorage.init();
    await remoteStorage.init();
    await localStorage.put("photo-1.jpg", Buffer.from("photo-data"), {
      contentType: "image/jpeg",
    });

    await fileSyncEngine.transferFile(
      { fileHash: "hash", objectStorageKey: "photo-1.jpg", sizeBytes: 10 },
      localStorage,
      remoteStorage,
    );

    const result = await remoteStorage.get("photo-1.jpg");
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("image/jpeg");
  });
});

describe("createSyncEngine", () => {
  it("should record changes and push to remote", async () => {
    const { syncEngine, localDatabase, remoteDatabase, localClock } =
      createTestSetup();

    await localDatabase.init();
    await remoteDatabase.init();

    const record = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      localClock,
    );
    await localDatabase.put(record);
    await syncEngine.recordChange("create", record);

    const pushResult = await syncEngine.push();
    expect(pushResult.accepted).toHaveLength(1);

    const remoteRecord = await remoteDatabase.get(record.id);
    expect(remoteRecord).not.toBeNull();
  });

  it("should pull remote changes to local", async () => {
    const { syncEngine, localDatabase, remoteDatabase, remoteClock } =
      createTestSetup();

    await localDatabase.init();
    await remoteDatabase.init();

    const remoteRecord = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      remoteClock,
    );
    await remoteDatabase.put(remoteRecord);

    const pullResult = await syncEngine.pull();
    expect(pullResult.changes.length).toBeGreaterThan(0);

    const localRecord = await localDatabase.get(remoteRecord.id);
    expect(localRecord).not.toBeNull();
  });

  it("should handle full sync round-trip", async () => {
    const { syncEngine, localDatabase, remoteDatabase, localClock } =
      createTestSetup();

    await localDatabase.init();
    await remoteDatabase.init();

    const record = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      localClock,
    );
    await localDatabase.put(record);
    await syncEngine.recordChange("create", record);

    const result = await syncEngine.fullSync();
    expect(result.pushed).toBeGreaterThanOrEqual(1);
  });

  it("should emit change notifications on pull", async () => {
    const { syncEngine, localDatabase, remoteDatabase, remoteClock } =
      createTestSetup();

    await localDatabase.init();
    await remoteDatabase.init();

    const listener = vi.fn();
    syncEngine.changeNotifier.subscribe(listener);

    const remoteRecord = createDataRecord(
      { type: "@test/photo", ownerId: "u1" },
      remoteClock,
    );
    await remoteDatabase.put(remoteRecord);

    await syncEngine.pull();
    expect(listener).toHaveBeenCalled();
  });
});
