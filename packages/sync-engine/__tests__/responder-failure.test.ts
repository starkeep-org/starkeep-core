/**
 * Rounds the **peer** threw away.
 *
 * Every other failure case in this suite happens on the node under test: a blob
 * that will not upload, a scan that will not read, a response lost in transit.
 * They all have a local symptom. This file covers the one that does not — the
 * responder halts an author on its first failed apply, skips the rest of that
 * author's items, and answers 200. Both scans drain. Every transfer succeeded.
 * Nothing landed.
 *
 * The *watermark* half of that has always been right (coverage stays behind the
 * row, so it re-ships — see `responder-watermarks.test.ts`). The two halves
 * covered here are the ones that were not:
 *
 *   1. `sync()` must not call such a round complete. For a peer whose apply
 *      fails persistently — an app whose schema is behind, a grant that was
 *      never made — every call otherwise returned "both directions drained"
 *      while the library was nowhere. That is the value `/sync/now` hands back
 *      and the one behind the phone's "Sync now" button.
 *   2. A repair floor must survive it. The floor sits *below* the peer's
 *      coverage watermark by construction, so once retired nothing ever asks
 *      for the hole again.
 */

import { describe, it, expect } from "vitest";
import {
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
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import { failingApplier } from "./sync-test-harness/failure-injection.js";
import {
  makeMockAppSource,
  type MockAppRowStore,
} from "./sync-test-harness/mock-app-source.js";
import type { AppSyncableRowEntry, SyncTransport } from "../src/types.js";

let sharedTime = 1000;
const wallClock = () => sharedTime++;

function makeClock(nodeId: string): HLCClock {
  return createHLCClock({ nodeId, wallClockFunction: wallClock });
}

function appRow(id: string, timestamp: HLCTimestamp): AppSyncableRowEntry {
  return {
    timestamp,
    appId: "test-app",
    table: "test_rows",
    op: "insert",
    row: { id, payload: `payload-${id}`, updated_at: serializeHLC(timestamp) },
  };
}

function appSource(): MockAppRowStore {
  return makeMockAppSource("test-app", [{ name: "test_rows", pkColumns: ["id"] }]);
}

async function makeCloud(source: MockAppRowStore, failing: () => boolean | ((e: AppSyncableRowEntry) => boolean)) {
  const db = new MockDatabaseAdapter();
  const storage = new MockObjectStorageAdapter();
  await db.init();
  await storage.init();
  const transport = createInProcessSyncTransport({
    databaseAdapter: db,
    clock: makeClock("cloud"),
    objectStorage: storage,
    syncSharedRecords: false,
    appSyncableSource: {
      namespaces: source.namespaces,
      applier: failingApplier(source.applier, (entry) => {
        const f = failing();
        return typeof f === "function" ? f(entry) : f;
      }),
    },
  });
  return { db, storage, transport };
}

async function makeDevice(
  nodeId: string,
  transport: SyncTransport,
  remoteStorage: MockObjectStorageAdapter,
) {
  const clock = makeClock(nodeId);
  const db = new MockDatabaseAdapter();
  const storage = new MockObjectStorageAdapter();
  await db.init();
  await storage.init();
  const syncState = createMemorySyncStateStore();
  const app = appSource();
  const engine = createSyncEngine({
    localDatabaseAdapter: db,
    localObjectStorage: storage,
    remoteObjectStorage: remoteStorage,
    transport,
    clock,
    syncState,
    syncSharedRecords: false,
    appSyncableSource: { namespaces: app.namespaces, applier: app.applier },
  });
  return { clock, db, storage, syncState, app, engine };
}

describe("a round the responder dropped", () => {
  it("names the halted authors in the response", async () => {
    // The wire field the two findings below both rest on. Without it the
    // requester has nothing to look at: the halt lives in a local Set on the
    // responder and used to die there.
    const cloudApp = appSource();
    const cloud = await makeCloud(cloudApp, () => true);
    const device = makeClock("device-1");

    const response = await cloud.transport.exchange({
      watermarks: {},
      appSyncableRows: [appRow("r1", device.now())],
    });

    expect(response.haltedAuthors).toEqual(["device-1"]);
    expect(cloudApp.rows.size).toBe(0);
  });

  it("omits the field entirely on a healthy round", async () => {
    // Absent must mean "nothing halted" — an older responder sends nothing here
    // and must not be read as having dropped everything.
    const cloudApp = appSource();
    const cloud = await makeCloud(cloudApp, () => false);
    const device = makeClock("device-1");

    const response = await cloud.transport.exchange({
      watermarks: {},
      appSyncableRows: [appRow("r1", device.now())],
    });

    expect(response.haltedAuthors).toBeUndefined();
    expect(cloudApp.rows.size).toBe(1);
  });

  it("does not report complete when the peer's apply always throws", async () => {
    // N1. One row, a budget it fits inside, an apply that never succeeds. Both
    // scans drain and no local transfer fails, so on the scan signals alone
    // this returned `complete: true, stalled: false` — twice in a row, with the
    // cloud table still empty.
    const cloudApp = appSource();
    const cloud = await makeCloud(cloudApp, () => true);
    const device = await makeDevice("device-1", cloud.transport, cloud.storage);
    await device.app.applier.apply(appRow("r1", device.clock.now()));

    const first = await device.engine.sync();
    expect(first.complete).toBe(false);
    expect(first.stalled).toBe(true);
    expect(cloudApp.rows.size).toBe(0);

    // And it stays honest on the next press rather than converging on a lie.
    const second = await device.engine.sync();
    expect(second.complete).toBe(false);
    expect(cloudApp.rows.size).toBe(0);
  });

  it("does not spin the whole round budget re-sending a row the peer discards", async () => {
    // The other half of the same fix. A shipment the responder threw away must
    // not count as progress, or refusing the `complete` exit simply converts a
    // silent success into 10,000 identical rounds.
    const cloudApp = appSource();
    const cloud = await makeCloud(cloudApp, () => true);
    const device = await makeDevice("device-1", cloud.transport, cloud.storage);
    await device.app.applier.apply(appRow("r1", device.clock.now()));

    const result = await device.engine.sync({ maxRounds: 500 });
    expect(result.rounds).toBeLessThan(5);
  });

  it("finishes once the peer recovers", async () => {
    // A dropped round is not a terminal state: the watermarks were never
    // advanced past the row, so the next call ships it again.
    const cloudApp = appSource();
    let failing = true;
    const cloud = await makeCloud(cloudApp, () => failing);
    const device = await makeDevice("device-1", cloud.transport, cloud.storage);
    await device.app.applier.apply(appRow("r1", device.clock.now()));

    expect((await device.engine.sync()).complete).toBe(false);
    failing = false;
    const recovered = await device.engine.sync();
    expect(recovered.complete).toBe(true);
    expect(recovered.stalled).toBe(false);
    expect(cloudApp.rows.size).toBe(1);
  });

  it("keeps the repair floor when the peer dropped the repair round", async () => {
    // N2. The mirror of `round-budget.test.ts`'s "keeps the floor when the
    // repair round's upload failed", with the failure moved to the far end of
    // the wire. `truncatedByFailure` records uploads only, so the floor — the
    // only record that the hole still needs filling — used to retire against a
    // round in which nothing landed.
    const cloudApp = appSource();
    let failing = false;
    const cloud = await makeCloud(cloudApp, () => failing);
    const device = await makeDevice("device-1", cloud.transport, cloud.storage);
    for (const id of ["r1", "r2", "r3"]) {
      await device.app.applier.apply(appRow(id, device.clock.now()));
    }
    await device.engine.sync();
    expect(cloudApp.rows.size).toBe(3);

    // Lose one from the middle. MAX(updated_at) is unchanged, so the coverage
    // report is unchanged and only the digest comparison can see it.
    for (const key of [...cloudApp.rows.keys()]) {
      if (key.endsWith("::r2")) cloudApp.rows.delete(key);
    }
    const verified = await device.engine.verify();
    expect(verified.divergentBuckets).toBeGreaterThan(0);
    expect(Object.keys(await device.syncState.getRepairFloors())).toEqual(["device-1"]);

    // Now the repair ships fine and is discarded on arrival.
    failing = true;
    const repair = await device.engine.sync();
    expect(repair.complete).toBe(false);
    expect(cloudApp.rows.size).toBe(2);
    expect(
      Object.keys(await device.syncState.getRepairFloors()),
      "the floor is the only thing still asking for this row",
    ).toEqual(["device-1"]);

    // And when the peer recovers, the still-armed floor completes the job.
    failing = false;
    await device.engine.sync();
    expect(cloudApp.rows.size).toBe(3);
    expect(await device.syncState.getRepairFloors()).toEqual({});
  });

  it("halting one author leaves another author's floor and coverage alone", async () => {
    // Test 3. Halting is per author on the responder; retention has to be per
    // author on the requester, or one device's broken row discards the repair
    // armed for another's.
    const cloudApp = appSource();
    const deviceClock = makeClock("device-1");
    const otherClock = makeClock("other-node");
    let failing = false;
    const cloud = await makeCloud(cloudApp, () =>
      failing ? (e: AppSyncableRowEntry) => e.timestamp.nodeId === "device-1" : false,
    );
    const device = await makeDevice("device-1", cloud.transport, cloud.storage);

    // Two authors' rows, both held locally — the device authored one set and
    // received the other from a third node at some earlier point.
    const mine: AppSyncableRowEntry[] = [];
    const theirs: AppSyncableRowEntry[] = [];
    for (let i = 0; i < 3; i += 1) {
      mine.push(appRow(`m${i}`, deviceClock.now()));
      theirs.push(appRow(`o${i}`, otherClock.now()));
    }
    for (const entry of [...mine, ...theirs]) await device.app.applier.apply(entry);
    await device.engine.sync();
    expect(cloudApp.rows.size).toBe(6);

    // Lose one row from each author, and arm both floors.
    for (const key of [...cloudApp.rows.keys()]) {
      if (key.endsWith("::m1") || key.endsWith("::o1")) cloudApp.rows.delete(key);
    }
    await device.engine.verify();
    expect(Object.keys(await device.syncState.getRepairFloors()).sort()).toEqual([
      "device-1",
      "other-node",
    ]);

    // The repair round: device-1's rows are dropped on arrival, other-node's
    // land. Only the halted author keeps its floor.
    failing = true;
    await device.engine.sync();
    expect(Object.keys(await device.syncState.getRepairFloors())).toEqual(["device-1"]);
    expect([...cloudApp.rows.keys()].some((k) => k.endsWith("::o1"))).toBe(true);
    expect([...cloudApp.rows.keys()].some((k) => k.endsWith("::m1"))).toBe(false);
  });
});
