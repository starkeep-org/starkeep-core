import { describe, it, expect, vi } from "vitest";
import {
  createHLCClock,
  createDataRecord,
  SyncStatus,
  type StarkeepId,
  type HLCTimestamp,
  type DataRecord,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createSyncEngine } from "../src/sync-engine.js";
import { createChangeLog } from "../src/change-log.js";
import { createChangeNotifier } from "../src/change-notifier.js";
import { createFileSyncEngine } from "../src/file-sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import {
  decidePullApply,
  decidePushAccept,
} from "../src/conflict-resolver.js";
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

  const transport = createInProcessSyncTransport({
    databaseAdapter: remoteDatabase,
    clock: localClock,
  });

  const syncEngine = createSyncEngine({
    localDatabaseAdapter: localDatabase,
    localObjectStorage,
    remoteObjectStorage,
    transport,
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

async function initAll(setup: ReturnType<typeof createTestSetup>) {
  await setup.localDatabase.init();
  await setup.remoteDatabase.init();
  await setup.localObjectStorage.init();
  await setup.remoteObjectStorage.init();
}

describe("createChangeLog", () => {
  it("appends entries with baseVersion", async () => {
    const changeLog = createChangeLog();
    const clock = createHLCClock({
      nodeId: "test",
      wallClockFunction: () => 1000,
    });
    const record = createDataRecord({ type: "@test/photo", ownerId: "u1", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);

    const entry = await changeLog.append({
      recordId: record.id,
      operation: "create",
      timestamp: clock.now(),
      recordSnapshot: record,
      baseVersion: null,
    });

    expect(entry.changeId).toBeDefined();
    expect(entry.baseVersion).toBeNull();
  });

  it("filters by HLC timestamp", async () => {
    const changeLog = createChangeLog();
    const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => 1000 });

    const r1 = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const r2 = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);

    await changeLog.append({
      recordId: r1.id,
      operation: "create",
      timestamp: { wallTime: 1000, counter: 0, nodeId: "test" },
      recordSnapshot: r1,
      baseVersion: null,
    });
    await changeLog.append({
      recordId: r2.id,
      operation: "create",
      timestamp: { wallTime: 3000, counter: 0, nodeId: "test" },
      recordSnapshot: r2,
      baseVersion: null,
    });

    const midpoint: HLCTimestamp = { wallTime: 2000, counter: 0, nodeId: "test" };
    const changes = await changeLog.getChangesSince(midpoint);
    expect(changes).toHaveLength(1);
    expect(changes[0].recordId).toBe(r2.id);
  });

  it("prunes old entries", async () => {
    const changeLog = createChangeLog();
    const clock = createHLCClock({ nodeId: "test", wallClockFunction: () => 1000 });
    const r1 = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const r2 = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    await changeLog.append({
      recordId: r1.id,
      operation: "create",
      timestamp: { wallTime: 1000, counter: 0, nodeId: "test" },
      recordSnapshot: r1,
      baseVersion: null,
    });
    await changeLog.append({
      recordId: r2.id,
      operation: "create",
      timestamp: { wallTime: 2000, counter: 0, nodeId: "test" },
      recordSnapshot: r2,
      baseVersion: null,
    });

    const pruned = await changeLog.prune({
      wallTime: 1500,
      counter: 0,
      nodeId: "test",
    });
    expect(pruned).toBe(1);
  });
});

describe("decidePushAccept (OCC server check)", () => {
  const clock = createHLCClock({ nodeId: "n", wallClockFunction: () => 1000 });

  it("accepts create when no server record exists", () => {
    const record = createDataRecord({ type: "@t/photo", ownerId: "u1", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const change: ChangeLogEntry = {
      changeId: "c1" as StarkeepId,
      recordId: record.id,
      operation: "create",
      timestamp: record.updatedAt,
      recordSnapshot: record,
      baseVersion: null,
    };
    expect(decidePushAccept(null, change).kind).toBe("accept");
  });

  it("treats create as accept-noop when server already has the exact (id,version)", () => {
    // Idempotency: a lost ack causes the client to re-push an already-applied
    // create. Server returns accept-noop so the client can finalize its state
    // machine without seeing a spurious version mismatch.
    const record = createDataRecord({ type: "@t/photo", ownerId: "u1", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const change: ChangeLogEntry = {
      changeId: "c1" as StarkeepId,
      recordId: record.id,
      operation: "create",
      timestamp: record.updatedAt,
      recordSnapshot: record,
      baseVersion: null,
    };
    expect(decidePushAccept(record, change).kind).toBe("accept-noop");
  });

  it("rejects create when server has a record at a different version", () => {
    const record = createDataRecord({ type: "@t/photo", ownerId: "u1", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const advanced: DataRecord = { ...record, version: 2 };
    const change: ChangeLogEntry = {
      changeId: "c1" as StarkeepId,
      recordId: record.id,
      operation: "create",
      timestamp: record.updatedAt,
      recordSnapshot: record,
      baseVersion: null,
    };
    expect(decidePushAccept(advanced, change).kind).toBe("reject-version-mismatch");
  });

  it("accepts update when baseVersion matches server", () => {
    const server = createDataRecord({ type: "@t/photo", ownerId: "u1", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const updated: DataRecord = {
      ...server,
      version: 2,
      updatedAt: { wallTime: 2000, counter: 0, nodeId: "n" },
    };
    const change: ChangeLogEntry = {
      changeId: "c1" as StarkeepId,
      recordId: server.id,
      operation: "update",
      timestamp: updated.updatedAt,
      recordSnapshot: updated,
      baseVersion: 1,
    };
    expect(decidePushAccept(server, change).kind).toBe("accept");
  });

  it("rejects update when baseVersion doesn't match", () => {
    const server = { ...createDataRecord({ type: "@t/photo", ownerId: "u1", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock), version: 3 };
    const change: ChangeLogEntry = {
      changeId: "c1" as StarkeepId,
      recordId: server.id,
      operation: "update",
      timestamp: server.updatedAt,
      recordSnapshot: { ...server, version: 2 } as DataRecord,
      baseVersion: 1,
    };
    expect(decidePushAccept(server, change).kind).toBe("reject-version-mismatch");
  });

  it("rejects update when record doesn't exist on server", () => {
    const record = createDataRecord({ type: "@t/photo", ownerId: "u1", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const change: ChangeLogEntry = {
      changeId: "c1" as StarkeepId,
      recordId: record.id,
      operation: "update",
      timestamp: record.updatedAt,
      recordSnapshot: record,
      baseVersion: 1,
    };
    expect(decidePushAccept(null, change).kind).toBe("reject-not-found");
  });
});

describe("decidePullApply", () => {
  const clock = createHLCClock({ nodeId: "n", wallClockFunction: () => 1000 });

  it("applies cleanly when local is absent", () => {
    const remote = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const change: ChangeLogEntry = {
      changeId: "c1" as StarkeepId,
      recordId: remote.id,
      operation: "update",
      timestamp: remote.updatedAt,
      recordSnapshot: remote,
      baseVersion: null,
    };
    expect(decidePullApply(null, change, undefined).kind).toBe("apply-clean");
  });

  it("flags local-dirty conflict when local has unsynced change", () => {
    const record = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const remoteChange: ChangeLogEntry = {
      changeId: "c1" as StarkeepId,
      recordId: record.id,
      operation: "update",
      timestamp: record.updatedAt,
      recordSnapshot: record,
      baseVersion: null,
    };
    const localChange: ChangeLogEntry = { ...remoteChange, changeId: "c2" as StarkeepId };
    expect(decidePullApply(record, remoteChange, localChange).kind).toBe(
      "local-dirty-conflict",
    );
  });

  it("skips when local version >= remote", () => {
    const record = createDataRecord({ type: "@t/x", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, clock);
    const local: DataRecord = { ...record, version: 5 };
    const remote: DataRecord = { ...record, version: 3 };
    const change: ChangeLogEntry = {
      changeId: "c1" as StarkeepId,
      recordId: record.id,
      operation: "update",
      timestamp: record.updatedAt,
      recordSnapshot: remote,
      baseVersion: 2,
    };
    expect(decidePullApply(local, change, undefined).kind).toBe("skip-already-current");
  });
});

describe("createChangeNotifier", () => {
  it("notifies and unsubscribes", () => {
    const notifier = createChangeNotifier();
    const listener = vi.fn();
    const unsub = notifier.subscribe(listener);
    notifier.emit({
      eventType: "local-data-synced",
      recordIds: [],
      timestamp: { wallTime: 1, counter: 0, nodeId: "t" },
    });
    expect(listener).toHaveBeenCalledOnce();
    unsub();
    notifier.emit({
      eventType: "local-data-synced",
      recordIds: [],
      timestamp: { wallTime: 2, counter: 0, nodeId: "t" },
    });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("createFileSyncEngine", () => {
  it("identifies files to push", async () => {
    const fileSyncEngine = createFileSyncEngine();
    const localStorage = new MockObjectStorageAdapter();
    const remoteStorage = new MockObjectStorageAdapter();
    await localStorage.init();
    await remoteStorage.init();
    await localStorage.put("photo-1.jpg", new Uint8Array([1, 2, 3]));

    const toPush = await fileSyncEngine.getFilesToPush(
      localStorage,
      remoteStorage,
      [{ key: "photo-1.jpg" }],
    );
    expect(toPush).toHaveLength(1);
  });

  it("transfers files", async () => {
    const fileSyncEngine = createFileSyncEngine();
    const localStorage = new MockObjectStorageAdapter();
    const remoteStorage = new MockObjectStorageAdapter();
    await localStorage.init();
    await remoteStorage.init();
    await localStorage.put("photo-1.jpg", new Uint8Array([1, 2, 3]), {
      contentType: "image/jpeg",
    });

    await fileSyncEngine.transferFile(
      { fileHash: "h", objectStorageKey: "photo-1.jpg", sizeBytes: 3 },
      localStorage,
      remoteStorage,
    );
    const result = await remoteStorage.get("photo-1.jpg");
    expect(result).not.toBeNull();
  });

  it("declines a concurrent transferFile for the same key", async () => {
    const fileSyncEngine = createFileSyncEngine();
    const localStorage = new MockObjectStorageAdapter();
    const remoteStorage = new MockObjectStorageAdapter();
    await localStorage.init();
    await remoteStorage.init();
    await localStorage.put("photo-1.jpg", new Uint8Array([1, 2, 3]));

    // Kick off the first transfer but don't await it.
    const first = fileSyncEngine.transferFile(
      { fileHash: "h", objectStorageKey: "photo-1.jpg", sizeBytes: 3 },
      localStorage,
      remoteStorage,
    );
    // The second call sees the in-flight set and bails out without doing work.
    expect(fileSyncEngine.isTransferInFlight("photo-1.jpg")).toBe(true);
    const second = await fileSyncEngine.transferFile(
      { fileHash: "h", objectStorageKey: "photo-1.jpg", sizeBytes: 3 },
      localStorage,
      remoteStorage,
    );
    expect(second).toBe(false);
    expect(await first).toBe(true);
    expect(fileSyncEngine.isTransferInFlight("photo-1.jpg")).toBe(false);
  });
});

describe("createSyncEngine — OCC round-trip", () => {
  it("push accepts a create and the record appears on remote", async () => {
    const setup = createTestSetup();
    await initAll(setup);
    const { syncEngine, localDatabase, remoteDatabase, localClock } = setup;

    const record = createDataRecord({ type: "@t/note", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, localClock);
    await localDatabase.put(record);
    await syncEngine.recordChange("create", record, { baseVersion: null });

    const pushResult = await syncEngine.push();
    expect(pushResult.accepted).toHaveLength(1);
    expect(pushResult.rejected).toHaveLength(0);

    const remoteRecord = await remoteDatabase.get(record.id);
    expect(remoteRecord).not.toBeNull();
  });

  it("push rejects when server version has advanced past baseVersion", async () => {
    const setup = createTestSetup();
    await initAll(setup);
    const { syncEngine, localDatabase, remoteDatabase, localClock } = setup;

    const record = createDataRecord({ type: "@t/note", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, localClock);
    await localDatabase.put(record);
    await remoteDatabase.put(record);

    // Remote advances to v2 behind our back.
    const remoteAdvanced: DataRecord = {
      ...record,
      version: 2,
      updatedAt: { wallTime: 2000, counter: 0, nodeId: "other" },
      originalFilename: "from other client",
    };
    await remoteDatabase.put(remoteAdvanced);

    const localUpdate: DataRecord = {
      ...record,
      version: 2,
      updatedAt: localClock.now(),
      originalFilename: "from us",
    };
    await localDatabase.put(localUpdate);
    await syncEngine.recordChange("update", localUpdate, { baseVersion: 1 });

    const pushResult = await syncEngine.push();
    expect(pushResult.accepted).toHaveLength(0);
    expect(pushResult.rejected).toHaveLength(1);
    expect(pushResult.rejected[0].reason).toBe("version-mismatch");

    const conflicts = syncEngine.getConflicts();
    expect(conflicts).toHaveLength(1);
    expect((conflicts[0].server as DataRecord).originalFilename).toBe("from other client");

    const localAfter = await localDatabase.get(record.id);
    expect(localAfter?.syncStatus).toBe(SyncStatus.Conflict);
  });

  it("pull applies new remote records and the file-transfer pass fetches the blob", async () => {
    const setup = createTestSetup();
    await initAll(setup);
    const { syncEngine, localDatabase, remoteDatabase, remoteObjectStorage, localObjectStorage, remoteClock } = setup;

    const remoteRecord = createDataRecord({ type: "@t/note", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, remoteClock);
    await remoteDatabase.put(remoteRecord);
    // Receiver downloads blobs from remote storage during the file-transfer pass.
    await remoteObjectStorage.put(remoteRecord.objectStorageKey, new Uint8Array([1, 2, 3, 4]), { contentType: "text/plain" });

    const pullResult = await syncEngine.pull();
    expect(pullResult.changes.length).toBeGreaterThan(0);

    const localRecord = await localDatabase.get(remoteRecord.id);
    expect(localRecord).not.toBeNull();
    // After pull + file-transfer pass, the blob is local and status is Synced.
    expect(localRecord?.syncStatus).toBe(SyncStatus.Synced);
    expect(await localObjectStorage.has(remoteRecord.objectStorageKey)).toBe(true);
  });

  it("pull leaves the record in PendingFileDownload when the blob is unreachable", async () => {
    const setup = createTestSetup();
    await initAll(setup);
    const { syncEngine, localDatabase, remoteDatabase, remoteClock } = setup;

    const remoteRecord = createDataRecord({ type: "@t/note", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, remoteClock);
    await remoteDatabase.put(remoteRecord);
    // Deliberately do NOT put the blob on remote storage.

    await syncEngine.pull();

    const localRecord = await localDatabase.get(remoteRecord.id);
    expect(localRecord?.syncStatus).toBe(SyncStatus.PendingFileDownload);
  });

  it("a subsequent file-transfer pass retries the blob and reaches Synced", async () => {
    const setup = createTestSetup();
    await initAll(setup);
    const { syncEngine, localDatabase, remoteDatabase, remoteObjectStorage, remoteClock } = setup;

    const remoteRecord = createDataRecord({ type: "@t/note", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, remoteClock);
    await remoteDatabase.put(remoteRecord);

    // First pull: blob missing remotely, record stuck in PendingFileDownload.
    await syncEngine.pull();
    expect((await localDatabase.get(remoteRecord.id))?.syncStatus).toBe(SyncStatus.PendingFileDownload);

    // Blob arrives upstream; a follow-up pass should pick it up.
    await remoteObjectStorage.put(remoteRecord.objectStorageKey, new Uint8Array([7, 7, 7]));
    await syncEngine.runFileTransferPass();

    expect((await localDatabase.get(remoteRecord.id))?.syncStatus).toBe(SyncStatus.Synced);
  });

  it("pull flags local-dirty conflict instead of clobbering unpushed change", async () => {
    const setup = createTestSetup();
    await initAll(setup);
    const { syncEngine, localDatabase, remoteDatabase, localClock, remoteClock } = setup;

    const record = createDataRecord({ type: "@t/note", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, localClock);
    await localDatabase.put(record);
    await remoteDatabase.put(record);

    // Remote advances to v2.
    const remoteAdvanced: DataRecord = {
      ...record,
      version: 2,
      updatedAt: remoteClock.now(),
      originalFilename: "remote change",
    };
    await remoteDatabase.put(remoteAdvanced);

    // Local has its own unsynced v2.
    const localAdvanced: DataRecord = {
      ...record,
      version: 2,
      updatedAt: localClock.now(),
      originalFilename: "local change",
    };
    await localDatabase.put(localAdvanced);
    await syncEngine.recordChange("update", localAdvanced, { baseVersion: 1 });

    await syncEngine.pull();

    const localAfter = (await localDatabase.get(record.id)) as DataRecord;
    expect(localAfter.originalFilename).toBe("local change");
    expect(localAfter.syncStatus).toBe(SyncStatus.Conflict);

    const conflicts = syncEngine.getConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].source).toBe("pull");
  });

  it("fullSync reports pulled, pushed, rejected counts", async () => {
    const setup = createTestSetup();
    await initAll(setup);
    const { syncEngine, localDatabase, localClock } = setup;

    const record = createDataRecord({ type: "@t/note", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, localClock);
    await localDatabase.put(record);
    await syncEngine.recordChange("create", record, { baseVersion: null });

    const result = await syncEngine.fullSync();
    expect(result.pushed).toBeGreaterThanOrEqual(1);
    expect(result.rejected).toBe(0);
  });

  it("emits local-data-synced on successful pull", async () => {
    const setup = createTestSetup();
    await initAll(setup);
    const { syncEngine, remoteDatabase, remoteClock } = setup;

    const listener = vi.fn();
    syncEngine.changeNotifier.subscribe(listener);

    const remoteRecord = createDataRecord({ type: "@t/note", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, remoteClock);
    await remoteDatabase.put(remoteRecord);

    await syncEngine.pull();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "local-data-synced" }),
    );
  });

  it("emits conflict-detected on push rejection", async () => {
    const setup = createTestSetup();
    await initAll(setup);
    const { syncEngine, localDatabase, remoteDatabase, localClock } = setup;

    const record = createDataRecord({ type: "@t/note", ownerId: "u", originAppId: "@starkeep/sync-engine", contentHash: "sha256:abc", objectStorageKey: "shared/test/ab/abc", mimeType: "text/plain", sizeBytes: 4 }, localClock);
    await localDatabase.put(record);
    await remoteDatabase.put({ ...record, version: 5 });

    const localAdvanced: DataRecord = {
      ...record,
      version: 2,
      updatedAt: localClock.now(),
    };
    await localDatabase.put(localAdvanced);
    await syncEngine.recordChange("update", localAdvanced, { baseVersion: 1 });

    const listener = vi.fn();
    syncEngine.changeNotifier.subscribe(listener);

    await syncEngine.push();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "conflict-detected" }),
    );
  });
});
