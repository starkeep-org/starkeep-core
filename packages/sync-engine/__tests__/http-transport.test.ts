import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createHLCClock,
  createDataRecord,
  type DataRecord,
  type CreateDataRecordInput,
} from "@starkeep/core";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
import { createHttpSyncHandler } from "../src/transports/http-server.js";
import { createHttpSyncTransport } from "../src/transports/http-transport.js";
import { createSyncEngine } from "../src/sync-engine.js";

function baseInput(over: Partial<CreateDataRecordInput> = {}): CreateDataRecordInput {
  return {
    type: "@test/note",
    ownerId: "u1",
    originAppId: "@starkeep/sync-engine",
    contentHash: `sha256:${Math.random().toString(36).slice(2)}`,
    objectStorageKey: `shared/@test/note/ab/${Math.random().toString(36).slice(2)}`,
    mimeType: "text/plain",
    sizeBytes: 4,
    ...over,
  };
}

async function startServer(
  handler: ReturnType<typeof createHttpSyncHandler>,
): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    try {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bad address");
  return { server, port: address.port };
}

describe("HTTP sync transport round-trip", () => {
  let server: Server;
  let port: number;
  let remoteDatabase: MockDatabaseAdapter;
  let remoteObjectStorage: MockObjectStorageAdapter;

  beforeAll(async () => {
    remoteDatabase = new MockDatabaseAdapter();
    remoteObjectStorage = new MockObjectStorageAdapter();
    await remoteDatabase.init();
    await remoteObjectStorage.init();

    const clock = createHLCClock({
      nodeId: "server",
      wallClockFunction: () => Date.now(),
    });
    const handler = createHttpSyncHandler({
      databaseAdapter: remoteDatabase,
      objectStorageAdapter: remoteObjectStorage,
      clock,
    });
    const started = await startServer(handler);
    server = started.server;
    port = started.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("pushes a create, second client pulls it", async () => {
    const baseUrl = `http://127.0.0.1:${port}`;

    const clientAClock = createHLCClock({
      nodeId: "A",
      wallClockFunction: () => Date.now(),
    });
    const clientADb = new MockDatabaseAdapter();
    const clientALocalObj = new MockObjectStorageAdapter();
    const clientARemoteObj = new MockObjectStorageAdapter();
    await clientADb.init();
    await clientALocalObj.init();
    await clientARemoteObj.init();

    const engineA = createSyncEngine({
      localDatabaseAdapter: clientADb,
      localObjectStorage: clientALocalObj,
      remoteObjectStorage: clientARemoteObj,
      transport: createHttpSyncTransport({ baseUrl }),
      clock: clientAClock,
    });

    const record = createDataRecord(
      baseInput({ originalFilename: "hi.txt" }),
      clientAClock,
    );
    await clientADb.put(record);
    await engineA.recordChange("create", record, { baseVersion: null });

    const pushResult = await engineA.push();
    expect(pushResult.accepted).toHaveLength(1);

    const onServer = await remoteDatabase.get(record.id);
    expect(onServer).not.toBeNull();

    const clientBClock = createHLCClock({
      nodeId: "B",
      wallClockFunction: () => Date.now(),
    });
    const clientBDb = new MockDatabaseAdapter();
    const clientBLocalObj = new MockObjectStorageAdapter();
    const clientBRemoteObj = new MockObjectStorageAdapter();
    await clientBDb.init();
    await clientBLocalObj.init();
    await clientBRemoteObj.init();

    const engineB = createSyncEngine({
      localDatabaseAdapter: clientBDb,
      localObjectStorage: clientBLocalObj,
      remoteObjectStorage: clientBRemoteObj,
      transport: createHttpSyncTransport({ baseUrl }),
      clock: clientBClock,
    });

    const pullResult = await engineB.pull();
    expect(pullResult.changes.length).toBeGreaterThan(0);

    const pulled = await clientBDb.get(record.id);
    expect(pulled).not.toBeNull();
    expect((pulled as DataRecord).originalFilename).toBe("hi.txt");
  });

  it("server rejects a push whose baseVersion is stale", async () => {
    const baseUrl = `http://127.0.0.1:${port}`;

    const serverClock = createHLCClock({
      nodeId: "server",
      wallClockFunction: () => Date.now(),
    });
    const record = createDataRecord(baseInput({ ownerId: "u2" }), serverClock);
    const recordV3: DataRecord = { ...record, version: 3 };
    await remoteDatabase.put(recordV3);

    const clientClock = createHLCClock({
      nodeId: "C",
      wallClockFunction: () => Date.now(),
    });
    const clientDb = new MockDatabaseAdapter();
    const clientLocal = new MockObjectStorageAdapter();
    const clientRemote = new MockObjectStorageAdapter();
    await clientDb.init();
    await clientLocal.init();
    await clientRemote.init();
    await clientDb.put({ ...recordV3, version: 1 });

    const engine = createSyncEngine({
      localDatabaseAdapter: clientDb,
      localObjectStorage: clientLocal,
      remoteObjectStorage: clientRemote,
      transport: createHttpSyncTransport({ baseUrl }),
      clock: clientClock,
    });

    const stale: DataRecord = {
      ...recordV3,
      version: 2,
      updatedAt: clientClock.now(),
      originalFilename: "stale",
    };
    await clientDb.put(stale);
    await engine.recordChange("update", stale, { baseVersion: 1 });

    const pushResult = await engine.push();
    expect(pushResult.rejected).toHaveLength(1);
    expect(pushResult.rejected[0].reason).toBe("version-mismatch");

    const conflicts = engine.getConflicts();
    expect(conflicts).toHaveLength(1);
    expect((conflicts[0].server as DataRecord).version).toBe(3);
  });
});
