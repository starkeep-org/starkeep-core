/**
 * What a round does when something other than a blob write fails.
 *
 * The suite's only injectable failure used to be an object-storage `put`, and
 * that was load-bearing in the wrong direction: every guard around a failed
 * *scan*, a failed *watermark read*, a failed *row write* and a lost *response*
 * was unreachable from a test, so those guards were assertions in prose. Two of
 * them were wrong. An applier caught a mid-scan read error and returned
 * `truncated: {}` — the wire value for "every author enumerated to the end" —
 * and the engine's `unreadableStream` handling, written precisely to stop a
 * round shipping around a gap, could never fire because the throw never reached
 * it.
 *
 * The property under test in the first three cases is one property: **a round
 * may not treat "I could not look" as "there is nothing there."** A scan that
 * failed has enumerated nothing it can vouch for, and shipping rows whose HLCs
 * sit above rows it never read is how a gap becomes permanent — the peer's
 * watermark advances over the hole and no future round ever asks for it again.
 */

import { describe, it, expect } from "vitest";
import {
  createDataRecord,
  generateId,
  serializeHLC,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { createSyncEngine } from "../src/sync-engine.js";
import { createInProcessSyncTransport } from "../src/transports/in-process-transport.js";
import { buildSide } from "./sync-test-harness/side.js";
import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
import {
  failingMethod,
  losingResponseTransport,
} from "./sync-test-harness/failure-injection.js";
import type {
  AppSyncableRowEntry,
  ScanCapableApplier,
  SyncStateStore,
} from "../src/types.js";

type Side = Awaited<ReturnType<typeof buildSide>>;

const APP_ID = "photos";

async function twoSides() {
  let t = 0;
  const wallClock = () => t++;
  return {
    local: await buildSide({ role: "local", nodeId: "L", wallClock, appId: APP_ID }),
    cloud: await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: APP_ID }),
  };
}

/** A shared record with no blob — this file is about rows, not bytes. */
async function seedRecord(side: Side): Promise<StarkeepId> {
  const id = generateId() as StarkeepId;
  await side.db.put({
    ...createDataRecord(
      {
        type: "@test/note",
        originAppId: APP_ID,
        contentHash: `sha256:${id}`,
        objectStorageKey: "",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      },
      side.clock,
    ),
    id,
  });
  return id;
}

/** One app-syncable row in `test_rows`, written through the applier. */
async function seedAppRow(side: Side, table = "test_rows"): Promise<string> {
  const pk = generateId();
  const ts = side.clock.now();
  const entry: AppSyncableRowEntry = {
    appId: APP_ID,
    table,
    op: "insert",
    where: { id: pk },
    row: { id: pk, value: "v", updated_at: serializeHLC(ts), deleted_at: null },
    timestamp: ts,
  };
  await side.applier.apply(entry);
  return pk;
}

/** A per-app channel: app-syncable rows only, with `applier` on the local end. */
function appChannel(
  local: Side,
  cloud: Side,
  syncState: SyncStateStore,
  applier: ScanCapableApplier = local.applier,
) {
  const transport = createInProcessSyncTransport({
    databaseAdapter: cloud.db,
    clock: cloud.clock,
    objectStorage: cloud.storage,
    appSyncableSource: { namespaces: cloud.namespaces, applier: cloud.applier },
    syncSharedRecords: false,
  });
  return createSyncEngine({
    localDatabaseAdapter: local.db,
    localObjectStorage: local.storage,
    remoteObjectStorage: cloud.storage,
    transport,
    clock: local.clock,
    syncState,
    syncSharedRecords: false,
    appSyncableSource: { namespaces: local.namespaces, applier },
  });
}

function cloudAppRowCount(cloud: Side, table = "test_rows"): number {
  return [...cloud.appRows.keys()].filter((k) => k.includes(`::${table}::`)).length;
}

describe("a scan that fails is not a scan that found nothing", () => {
  it("ships nothing at all when one table cannot be read", async () => {
    const { local, cloud } = await twoSides();
    // Two tables, one row in each. The engine scans every registered table
    // every round, so a failure in one of them has to stop the *whole* round:
    // the coverage watermark spans both, and shipping the readable table's row
    // would lift the peer's watermark over whatever the unreadable one holds.
    await seedAppRow(local, "test_rows");
    await seedAppRow(local, "_starkeep_sync_records");

    const engine = appChannel(
      local,
      cloud,
      createMemorySyncStateStore(),
      failingMethod(local.applier, "scanSince", {
        message: "[test] table is unreadable",
      }),
    );
    const result = await engine.exchange();

    expect(result.shipped).toBe(0);
    expect(cloudAppRowCount(cloud, "test_rows")).toBe(0);
    expect(cloudAppRowCount(cloud, "_starkeep_sync_records")).toBe(0);
    // …and the round asks to be run again rather than reporting itself drained.
    expect(result.outboundHasMore).toBe(true);
  });

  it("does not report the sync complete while a table stays unreadable", async () => {
    const { local, cloud } = await twoSides();
    await seedAppRow(local);

    const engine = appChannel(
      local,
      cloud,
      createMemorySyncStateStore(),
      failingMethod(local.applier, "scanSince", {
        message: "[test] table is unreadable",
      }),
    );
    const result = await engine.sync();

    // Not complete, and not an infinite loop either: the round achieves
    // nothing, so the progress guard stops it and says why.
    expect(result.complete).toBe(false);
    expect(result.stalled).toBe(true);
    expect(result.shipped).toBe(0);
  });

  it("ships everything once the table becomes readable again", async () => {
    const { local, cloud } = await twoSides();
    await seedAppRow(local);
    await seedAppRow(local);

    // The failure is the transient kind — a locked table, a dropped
    // connection. Nothing about the first round may prevent the second from
    // shipping what the first could not read.
    const engine = appChannel(
      local,
      cloud,
      createMemorySyncStateStore(),
      failingMethod(local.applier, "scanSince", { failFor: 2 }),
    );
    const result = await engine.sync();

    expect(result.complete).toBe(true);
    expect(cloudAppRowCount(cloud)).toBe(2);
  });

  it("treats a failed watermark read the same way, not as an empty table", async () => {
    const { local, cloud } = await twoSides();
    await seedAppRow(local);

    // `getNodeWatermarks` is what a scan plans from: no watermarks means no
    // authors to scan, which reads as "nothing owed" — a silent empty round on
    // a table that is full. Both real appliers call it outside the catch for
    // exactly this reason, so the failure propagates and the round stops.
    const engine = appChannel(
      local,
      cloud,
      createMemorySyncStateStore(),
      failingMethod(local.applier, "getNodeWatermarks", {
        message: "[test] watermark read failed",
      }),
    );
    const result = await engine.exchange();

    expect(result.shipped).toBe(0);
    expect(result.outboundHasMore).toBe(true);
    expect(cloudAppRowCount(cloud)).toBe(0);
  });
});

describe("an inbound write that fails holds the author's watermark", () => {
  it("does not advance past a record it could not store", async () => {
    const { local, cloud } = await twoSides();
    const id = await seedRecord(cloud);

    // Pull direction: the cloud holds a record, the local database refuses to
    // store it. The round must not persist a watermark that says otherwise —
    // if it did, the responder would never ship this record again and it would
    // be missing from this node permanently.
    const syncState = createMemorySyncStateStore();
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const breakingEngine = createSyncEngine({
      localDatabaseAdapter: failingMethod(local.db, "put", {
        message: "[test] disk is full",
        failFor: 1,
      }),
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport,
      clock: local.clock,
      syncState,
      syncSharedRecords: true,
    });

    // The round completes. A row that will not apply costs that row, not the
    // exchange: an escaping throw stops every author's items behind it and the
    // app's sync in both directions, and repeats every round, because the
    // watermark never moves to let anything else through.
    const result = await breakingEngine.exchange();
    expect(result.applied).toBe(0);
    expect(await syncState.getWatermarks()).toEqual({});
    expect(await local.db.get(id)).toBeNull();

    // The same state store, a working adapter: the record arrives, because
    // nothing recorded that it had already been seen.
    const healthy = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport,
      clock: local.clock,
      syncState,
      syncSharedRecords: true,
    });
    await healthy.sync();

    expect(await local.db.get(id)).not.toBeNull();
  });

  it("applies the rest of the round around the row it could not store", async () => {
    const { local, cloud } = await twoSides();
    const blocked = await seedRecord(cloud);
    const behind = await seedRecord(cloud);

    // The cost of the wedge was never the one record. The throw left
    // `exchange()` before any other author's items were processed, so
    // everything queued behind the bad row stopped moving too — which is how
    // one unappliable record became "no sync for this app, in either
    // direction". Failing the first `put` and nothing after it is that shape:
    // the record behind it has to land in the same round.
    const syncState = createMemorySyncStateStore();
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: failingMethod(local.db, "put", {
        message: "[test] disk is full",
        failFor: 1,
      }),
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport,
      clock: local.clock,
      syncState,
      syncSharedRecords: true,
    });

    await engine.exchange();

    expect(await local.db.get(blocked)).toBeNull();
    expect(await local.db.get(behind)).not.toBeNull();
    // And the author's watermark stays behind the row that failed, so the
    // peer keeps offering it rather than considering it delivered.
    expect(await syncState.getWatermarks()).toEqual({});
  });

  it("does not advance past a label it could not store", async () => {
    const { local, cloud } = await twoSides();
    const id = await seedRecord(cloud);
    const labelledAt = cloud.clock.now();
    await cloud.db.putLabel({
      recordId: id,
      appId: APP_ID,
      key: "album",
      value: "trip",
      recordType: "@test/note",
      createdAt: labelledAt,
      updatedAt: labelledAt,
      nodeId: labelledAt.nodeId,
      deletedAt: null,
    });

    const syncState = createMemorySyncStateStore();
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const engineWith = (db: typeof local.db) =>
      createSyncEngine({
        localDatabaseAdapter: db,
        localObjectStorage: local.storage,
        remoteObjectStorage: cloud.storage,
        transport,
        clock: local.clock,
        syncState,
        syncSharedRecords: true,
      });

    await expect(
      engineWith(
        failingMethod(local.db, "putLabel", {
          message: "[test] label write failed",
          failFor: 1,
        }),
      ).exchange(),
    ).rejects.toThrow("[test] label write failed");
    expect(await syncState.getWatermarks()).toEqual({});

    await engineWith(local.db).sync();

    expect(
      await local.db.getLabel(id, APP_ID, "album", "trip"),
    ).not.toBeNull();
  });
});

describe("a response lost after the peer applied it", () => {
  it("does not re-ship what the peer already holds", async () => {
    const { local, cloud } = await twoSides();
    const ids = [await seedRecord(local), await seedRecord(local), await seedRecord(local)];

    // The hard half of a dropped connection: the peer's state moved and ours
    // did not. Our cached `peerWatermarks` are stale-low, so a round that
    // pushed against them would re-ship all three — which is why a session
    // pulls before it pushes, adopting the peer's real coverage first.
    const syncState = createMemorySyncStateStore();
    const base = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const engineWith = (transport: typeof base) =>
      createSyncEngine({
        localDatabaseAdapter: local.db,
        localObjectStorage: local.storage,
        remoteObjectStorage: cloud.storage,
        transport,
        clock: local.clock,
        syncState,
        syncSharedRecords: true,
      });

    await expect(
      engineWith(losingResponseTransport(base)).exchange(),
    ).rejects.toThrow(/lost in transit/);

    // The peer applied everything even though we never heard so.
    for (const id of ids) expect(await cloud.db.get(id)).not.toBeNull();
    expect(await syncState.getPeerWatermarks()).toEqual({});

    const shipped: number[] = [];
    const result = await engineWith(base).sync({
      onRound: (r) => shipped.push(r.shipped),
    });

    expect(result.complete).toBe(true);
    expect(shipped.reduce((a, b) => a + b, 0)).toBe(0);
  });
});
