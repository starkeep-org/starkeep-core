import { createMemorySyncStateStore } from "./sync-test-harness/memory-sync-state.js";
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
import type { AppSyncableRowEntry, SyncStateStore, Watermarks } from "../src/types.js";

/**
 * Channel split — SR vs. AR/AW.
 *
 * The always-on Starkeep Drive channel (syncSharedRecords=true, no
 * appSyncableSource) carries *all* shared records and nothing app-specific;
 * every per-app channel (syncSharedRecords=false) carries only that app's
 * app-specific rows and no shared records. These tests lock that split in on
 * both the engine (requester) and the in-process transport (responder).
 */
describe("channel split — SR vs. AR/AW", () => {

  async function seedSr(side: Awaited<ReturnType<typeof buildSide>>): Promise<StarkeepId> {
    const id = generateId() as StarkeepId;
    const rec = {
      ...createDataRecord(
        {
          type: "@test/photo",
          originAppId: "photos",
          contentHash: "sha256:x",
          objectStorageKey: "",
          mimeType: "application/octet-stream",
          sizeBytes: 0,
        },
        side.clock,
      ),
      id,
    };
    await side.db.put(rec);
    return id;
  }

  async function seedAr(side: Awaited<ReturnType<typeof buildSide>>, appId: string): Promise<string> {
    const pk = generateId();
    const ts = side.clock.now();
    const entry: AppSyncableRowEntry = {
      appId,
      table: "test_rows",
      op: "insert",
      where: { id: pk },
      // `updated_at` is the column every scan, watermark and digest reads. A
      // row without it is not a row any real applier would store.
      row: { id: pk, value: "v", updated_at: serializeHLC(ts), deleted_at: null },
      timestamp: ts,
    };
    await side.applier.apply(entry);
    return pk;
  }

  it("per-app channel (syncSharedRecords=false) ships only AR, not SR", async () => {
    let t = 0;
    const wallClock = () => t++;
    const appId = "photos";
    const local = await buildSide({ role: "local", nodeId: "L", wallClock, appId });
    const cloud = await buildSide({ role: "cloud", nodeId: "C", wallClock, appId });

    const srId = await seedSr(local);
    await seedAr(local, appId);

    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      appSyncableSource: { namespaces: cloud.namespaces, applier: cloud.applier },
      syncSharedRecords: false,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport,
      clock: local.clock,
      syncState: createMemorySyncStateStore(),
      syncSharedRecords: false,
      appSyncableSource: {
        namespaces: local.namespaces,
        applier: local.applier as never,
      },
    });

    await engine.exchange();

    // SR did NOT cross the per-app channel…
    expect(await cloud.db.get(srId)).toBeNull();
    // …but the AR row did.
    const arRows = [...cloud.appRows.keys()].filter((k) => k.includes("::test_rows::"));
    expect(arRows.length).toBe(1);
  });

  it("Drive channel (syncSharedRecords=true, no appSyncableSource) ships SR only", async () => {
    let t = 0;
    const wallClock = () => t++;
    const appId = "photos";
    const local = await buildSide({ role: "local", nodeId: "L", wallClock, appId });
    const cloud = await buildSide({ role: "cloud", nodeId: "C", wallClock, appId });

    const srId = await seedSr(local);
    await seedAr(local, appId);

    // Drive channel: SR only, no appSyncableSource on either side.
    const transport = createInProcessSyncTransport({
      databaseAdapter: cloud.db,
      clock: cloud.clock,
      objectStorage: cloud.storage,
      syncSharedRecords: true,
    });
    const engine = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport,
      clock: local.clock,
      syncState: createMemorySyncStateStore(),
      syncSharedRecords: true,
    });

    await engine.exchange();

    // SR crossed the Drive channel…
    expect(await cloud.db.get(srId)).not.toBeNull();
    // …and no AR rows were shipped (the Drive channel carries none).
    const arRows = [...cloud.appRows.keys()].filter((k) => k.includes("::test_rows::"));
    expect(arRows.length).toBe(0);
  });
});

/**
 * The integrity check has to respect the channel split too.
 *
 * A per-app channel carries only that app's tables. A digest that always
 * covered shared records would hand it counts over rows the channel never
 * ships — divergence that means nothing, and repair floors for a repair the
 * channel cannot perform.
 */
describe("verify() is scoped to the channel", () => {
  it("digests the app's tables on a per-app channel, not shared records", async () => {
    let t = 0;
    const wallClock = () => t++;
    const local = await buildSide({ role: "local", nodeId: "L", wallClock, appId: "test-app" });
    const cloud = await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: "test-app" });

    // Shared records exist on both sides but are not this channel's business.
    // Only the local one, so a shared-record digest would report divergence.
    await local.db.put(
      createDataRecord(
        {
          type: "image/jpeg",
          originAppId: "test-app",
          contentHash: "sha256:shared",
          objectStorageKey: "",
          mimeType: "application/octet-stream",
          sizeBytes: 0,
        },
        local.clock,
      ),
    );

    const engine = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport: createInProcessSyncTransport({
        databaseAdapter: cloud.db,
        clock: cloud.clock,
        objectStorage: cloud.storage,
        syncSharedRecords: false,
        appSyncableSource: { namespaces: cloud.namespaces, applier: cloud.applier },
      }),
      clock: local.clock,
      syncState: createMemorySyncStateStore(),
      syncSharedRecords: false,
      appSyncableSource: { namespaces: local.namespaces, applier: local.applier },
    });

    const result = await engine.verify();
    expect(result.supported).toBe(true);
    // The local shared record is invisible to this channel in both directions.
    expect(result.localRows).toBe(0);
    expect(result.divergentBuckets).toBe(0);
    expect(result.missingLocally).toBe(0);
  });

  it("counts the app's own rows and finds a hole in them", async () => {
    let t = 0;
    const wallClock = () => t++;
    const local = await buildSide({ role: "local", nodeId: "L", wallClock, appId: "test-app" });
    const cloud = await buildSide({ role: "cloud", nodeId: "C", wallClock, appId: "test-app" });

    for (let i = 0; i < 3; i += 1) {
      const ts = local.clock.now();
      await local.applier.apply({
        appId: "test-app",
        table: "test_rows",
        op: "insert",
        row: {
          id: `r${i}`,
          note: `n${i}`,
          updated_at: serializeHLC(ts),
          deleted_at: null,
        },
        timestamp: ts,
      });
    }

    const engine = createSyncEngine({
      localDatabaseAdapter: local.db,
      localObjectStorage: local.storage,
      remoteObjectStorage: cloud.storage,
      transport: createInProcessSyncTransport({
        databaseAdapter: cloud.db,
        clock: cloud.clock,
        objectStorage: cloud.storage,
        syncSharedRecords: false,
        appSyncableSource: { namespaces: cloud.namespaces, applier: cloud.applier },
      }),
      clock: local.clock,
      syncState: createMemorySyncStateStore(),
      syncSharedRecords: false,
      appSyncableSource: { namespaces: local.namespaces, applier: local.applier },
    });
    await engine.sync();
    expect((await engine.verify()).localRows).toBe(3);

    // Lose one from the peer's middle: MAX(updated_at) does not move, so only
    // a count comparison can see it.
    cloud.appRows.delete("test-app::test_rows::r1");
    const after = await engine.verify();
    expect(after.divergentBuckets).toBeGreaterThan(0);
    expect(after.peerRows).toBe(2);
  });
});
