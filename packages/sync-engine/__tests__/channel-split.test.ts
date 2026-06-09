import { describe, it, expect } from "vitest";
import { createDataRecord, generateId, type StarkeepId } from "@starkeep/protocol-primitives";
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
  function makeSyncState(): SyncStateStore {
    // Per-channel in production; a fresh in-memory store per engine here.
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
    const entry: AppSyncableRowEntry = {
      appId,
      table: "test_rows",
      op: "insert",
      where: { id: pk },
      row: { id: pk, value: "v" },
      timestamp: side.clock.now(),
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
      syncState: makeSyncState(),
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
    const arRows = [...cloud.appRows.values()].filter((e) => e.table === "test_rows");
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
      syncState: makeSyncState(),
      syncSharedRecords: true,
    });

    await engine.exchange();

    // SR crossed the Drive channel…
    expect(await cloud.db.get(srId)).not.toBeNull();
    // …and no AR rows were shipped (the Drive channel carries none).
    const arRows = [...cloud.appRows.values()].filter((e) => e.table === "test_rows");
    expect(arRows.length).toBe(0);
  });
});
