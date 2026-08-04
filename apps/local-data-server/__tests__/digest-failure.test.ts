/**
 * The integrity check against a table that will not read — through the *real*
 * applier.
 *
 * The engine has two guards for this: `localBucketDigest`'s `complete = false`
 * and the responder's decision to omit the digest entirely. Both were written
 * against a throw, and until now no real applier ever threw — `bucketDigest`
 * turned every failure into `[]`, which is the wire value for "this table holds
 * nothing". So the guards passed their unit tests by being handed an injected
 * exception the production code could not produce.
 *
 * These cases close that gap by assembling the real pieces: the real
 * `SqliteAppSyncableApplier` over a real SQLite database, the real
 * `createSyncEngine`, and the real in-process transport as the peer. The
 * "unreadable" table is genuinely unreadable — it exists, and the `updated_at`
 * column every read needs does not — so nothing here is injected.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHLCClock } from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
} from "@starkeep/storage-adapter";
// Source, not `dist/` — the same relative-import convention `sync-supervisor.ts`
// uses. Both of these were changed by the fix under test, and a stale build
// would let these cases pass against the behaviour they exist to rule out.
import { SqliteAppSyncableApplier } from "../../../packages/storage-sqlite/src/app-syncable/apply.js";
import { createSyncEngine } from "../../../packages/sync-engine/src/sync-engine.js";
import { createInProcessSyncTransport } from "../../../packages/sync-engine/src/transports/in-process-transport.js";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  SyncStateStore,
  Watermarks,
} from "../../../packages/sync-engine/src/types.js";

const APP = "notes";
const TABLE = "note";
/** `appSyncableTableName` for the pair above; the applier is not exported with it. */
const FULL_NAME = "notes_syncable_note";

function namespaceStore(): AppSyncableNamespaceStore {
  const ns: AppSyncableNamespace = {
    appId: APP,
    tables: [{ name: TABLE, pkColumns: ["id"] }],
    filesEnabled: false,
    tableNames: [TABLE],
  };
  return { get: (id) => (id === APP ? ns : null), list: () => [ns] };
}

function seedRows(db: DatabaseSync): void {
  db.exec(
    `INSERT INTO ${FULL_NAME} (id, payload, updated_at, node_id)
     VALUES ('r1', 'a', '0000000003e8:0000:N', 'N'),
            ('r2', 'b', '0000000003e9:0000:N', 'N')`,
  );
}

/** A table the applier can count. */
function healthyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE ${FULL_NAME} (
       id TEXT PRIMARY KEY, payload TEXT,
       updated_at TEXT, deleted_at TEXT, node_id TEXT
     )`,
  );
  seedRows(db);
  return db;
}

/** A table that exists and holds rows, and whose reads fail. */
function unreadableDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ${FULL_NAME} (id TEXT PRIMARY KEY, payload TEXT)`);
  db.exec(`INSERT INTO ${FULL_NAME} (id, payload) VALUES ('r1', 'a'), ('r2', 'b')`);
  return db;
}

function memorySyncState(): SyncStateStore {
  let own: Watermarks = {};
  let peer: Watermarks = {};
  let repair: Watermarks = {};
  let inbound: Watermarks = {};
  return {
    async getWatermarks() {
      return own;
    },
    async setWatermarks(w) {
      own = w;
    },
    async getPeerWatermarks() {
      return peer;
    },
    async setPeerWatermarks(w) {
      peer = w;
    },
    async getRepairFloors() {
      return repair;
    },
    async setRepairFloors(w) {
      repair = w;
    },
    async getInboundFloors() {
      return inbound;
    },
    async setInboundFloors(w) {
      inbound = w;
    },
    async getHlcClockState() {
      return null;
    },
    async setHlcClockState() {},
  };
}

async function buildPair(local: DatabaseSync, cloud: DatabaseSync) {
  const cloudDb = new MockDatabaseAdapter();
  const cloudStorage = new MockObjectStorageAdapter();
  await cloudDb.init();
  await cloudStorage.init();
  const cloudApplier = new SqliteAppSyncableApplier(cloud as never, namespaceStore());
  const transport = createInProcessSyncTransport({
    databaseAdapter: cloudDb,
    clock: createHLCClock({ nodeId: "cloud" }),
    objectStorage: cloudStorage,
    syncSharedRecords: false,
    appSyncableSource: { namespaces: namespaceStore(), applier: cloudApplier },
  });

  const localDb = new MockDatabaseAdapter();
  const localStorage = new MockObjectStorageAdapter();
  await localDb.init();
  await localStorage.init();
  const localApplier = new SqliteAppSyncableApplier(local as never, namespaceStore());
  const syncState = memorySyncState();
  const engine = createSyncEngine({
    localDatabaseAdapter: localDb,
    localObjectStorage: localStorage,
    remoteObjectStorage: cloudStorage,
    transport,
    clock: createHLCClock({ nodeId: "device" }),
    syncState,
    syncSharedRecords: false,
    appSyncableSource: { namespaces: namespaceStore(), applier: localApplier },
  });
  return { engine, syncState, transport };
}

describe("verify() against a table that will not read", () => {
  it("verifies normally when both sides can count", async () => {
    // The control. Without it the two refusals below prove nothing — a guard
    // that always fires is not a guard.
    const { engine } = await buildPair(healthyDb(), healthyDb());
    const result = await engine.verify();
    expect(result.supported).toBe(true);
    expect(result.localRows).toBe(2);
    expect(result.peerRows).toBe(2);
    expect(result.divergentBuckets).toBe(0);
  });

  it("reports unsupported when the local digest could not be counted", async () => {
    // Test 5. The undercount would otherwise read as rows the peer holds and we
    // do not: `missingLocally`, an inbound floor of `wallTime: 0` — "re-send me
    // this author's entire history" — for rows this node already has. On a
    // phone that is the "Check backup" screen reporting a hole that isn't there,
    // plus a full re-download.
    const { engine, syncState } = await buildPair(unreadableDb(), healthyDb());
    const result = await engine.verify();
    expect(result.supported).toBe(false);
    expect(result.missingLocally).toBe(0);
    expect(await syncState.getInboundFloors()).toEqual({});
    expect(await syncState.getRepairFloors()).toEqual({});
  });

  it("declines to compare when the outbound backlog could not be read", async () => {
    // Test 11. `hasOutboundBacklog()` swallowed a failed scan and answered
    // "nothing owed", so an unreadable table read as a *drained* outbound side —
    // and `verify()` then reported every bucket in it as the peer's loss and
    // armed a repair for rows it could not even enumerate. The digest guard
    // below would not have caught it: this decision is made before the digests
    // are compared at all.
    const { engine, syncState } = await buildPair(unreadableDb(), healthyDb());
    const result = await engine.verify();
    expect(result.supported).toBe(false);
    expect(result.divergentBuckets).toBe(0);
    expect(result.pendingUpload).toBe(0);
    expect(await syncState.getRepairFloors()).toEqual({});
  });

  it("omits the responder's digest rather than under-reporting it", async () => {
    // Test 6. From the other end: an undercount on the responder makes the
    // requester see `local > peer` and re-ship the library.
    const { engine, transport, syncState } = await buildPair(healthyDb(), unreadableDb());

    const response = await transport.exchange({
      watermarks: {},
      limit: 0,
      requestDigest: true,
    });
    expect(response.digest).toBeUndefined();

    const result = await engine.verify();
    expect(result.supported).toBe(false);
    expect(result.divergentBuckets).toBe(0);
    expect(await syncState.getRepairFloors()).toEqual({});
  });
});
