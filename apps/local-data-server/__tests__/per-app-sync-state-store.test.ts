/**
 * Per-channel sync state, and what "per-channel" has to mean.
 *
 * Every channel is a separate conversation with the cloud — the Drive channel
 * carries shared records, each app's channel carries only its own rows — and
 * they all keep their position in one `sync_state` table. Scoping is the only
 * thing keeping them apart, so a key that fails to scope is a channel adopting
 * another's position: the app channel would advertise coverage over rows it has
 * never seen, and the peer would stop shipping them.
 *
 * Watermarks were scoped from the start. The repair and inbound floors are new
 * on this branch and had no test at all, which is the pair that matters most —
 * a floor is the only record that a hole still needs filling, so one channel
 * clearing another's would make a repair report success and do nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteDatabaseAdapter } from "@starkeep/storage-sqlite";
import { nodeSqliteDriver } from "../../../packages/storage-sqlite/src/node-driver.js";
import { createSqliteSyncStateStore } from "../../../packages/sync-engine/src/sync-state-sqlite.js";
import type { RawDatabase } from "@starkeep/storage-adapter";
import type { SyncStateStore, Watermarks } from "@starkeep/sync-engine";
import { createPerAppSyncStateStore } from "../per-app-sync-state-store.js";

const hlc = (wallTime: number, nodeId: string) => ({ wallTime, counter: 0, nodeId });

describe("per-app sync state", () => {
  let adapter: SqliteDatabaseAdapter;
  let db: RawDatabase;
  let underlying: SyncStateStore;
  let drive: SyncStateStore;
  let photos: SyncStateStore;

  beforeEach(async () => {
    adapter = new SqliteDatabaseAdapter({ path: ":memory:", driver: nodeSqliteDriver });
    await adapter.init();
    db = adapter.getRawDatabase();
    underlying = createSqliteSyncStateStore({ db });
    drive = createPerAppSyncStateStore(db, underlying, "starkeep-drive");
    photos = createPerAppSyncStateStore(db, underlying, "photos");
  });

  afterEach(async () => {
    await adapter.close();
  });

  const pairs: ReadonlyArray<{
    readonly name: string;
    readonly get: (s: SyncStateStore) => Promise<Watermarks>;
    readonly set: (s: SyncStateStore, w: Watermarks) => Promise<void>;
  }> = [
    { name: "watermarks", get: (s) => s.getWatermarks(), set: (s, w) => s.setWatermarks(w) },
    {
      name: "peer watermarks",
      get: (s) => s.getPeerWatermarks(),
      set: (s, w) => s.setPeerWatermarks(w),
    },
    {
      name: "repair floors",
      get: (s) => s.getRepairFloors(),
      set: (s, w) => s.setRepairFloors(w),
    },
    {
      name: "inbound floors",
      get: (s) => s.getInboundFloors(),
      set: (s, w) => s.setInboundFloors(w),
    },
  ];

  for (const pair of pairs) {
    describe(pair.name, () => {
      it("reads back what that channel wrote", async () => {
        await pair.set(drive, { L: hlc(5, "L") });
        expect(await pair.get(drive)).toEqual({ L: hlc(5, "L") });
      });

      it("is invisible to another channel", async () => {
        await pair.set(drive, { L: hlc(5, "L") });
        expect(await pair.get(photos)).toEqual({});
      });

      it("is not overwritten when another channel writes its own", async () => {
        await pair.set(drive, { L: hlc(5, "L") });
        await pair.set(photos, { L: hlc(9, "L") });
        expect(await pair.get(drive)).toEqual({ L: hlc(5, "L") });
        expect(await pair.get(photos)).toEqual({ L: hlc(9, "L") });
      });

      it("is not cleared when another channel clears its own", async () => {
        // The floor case in particular: retiring a repair on one channel while
        // another still needs one would drop the only record that the hole is
        // still open.
        await pair.set(drive, { L: hlc(5, "L") });
        await pair.set(photos, { L: hlc(9, "L") });
        await pair.set(photos, {});
        expect(await pair.get(drive)).toEqual({ L: hlc(5, "L") });
        expect(await pair.get(photos)).toEqual({});
      });

      it("starts empty rather than undefined", async () => {
        expect(await pair.get(photos)).toEqual({});
      });
    });
  }

  it("keeps the four kinds of position apart within one channel", async () => {
    // They are four different questions about the same channel — where we are,
    // where the peer says it is, and the two repair bounds — and a shared key
    // would make a repair look like coverage.
    await drive.setWatermarks({ L: hlc(1, "L") });
    await drive.setPeerWatermarks({ L: hlc(2, "L") });
    await drive.setRepairFloors({ L: hlc(3, "L") });
    await drive.setInboundFloors({ L: hlc(4, "L") });

    expect(await drive.getWatermarks()).toEqual({ L: hlc(1, "L") });
    expect(await drive.getPeerWatermarks()).toEqual({ L: hlc(2, "L") });
    expect(await drive.getRepairFloors()).toEqual({ L: hlc(3, "L") });
    expect(await drive.getInboundFloors()).toEqual({ L: hlc(4, "L") });
  });

  it("shares the HLC clock across channels, because a node has one clock", async () => {
    // The deliberate exception to the scoping. Two channels with independent
    // clock state would let the same node issue two different times, and every
    // LWW comparison in the system rests on that not happening.
    await drive.setHlcClockState({ wallTime: 42, counter: 7 });
    expect(await photos.getHlcClockState()).toEqual({ wallTime: 42, counter: 7 });
    expect(await underlying.getHlcClockState()).toEqual({ wallTime: 42, counter: 7 });
  });
});
