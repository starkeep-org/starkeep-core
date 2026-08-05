/**
 * A repair floor round-tripped through a restart, on a per-app channel.
 *
 * `per-app-sync-state-store.test.ts` pins that the four kinds of position stay
 * scoped to their channel, but it writes them by hand and reads them back
 * through the same open handle. `sync-over-wire.test.ts` restarts a server and
 * checks that *watermarks* survived. Nothing did both, and the floor is the one
 * position where losing it is silent: a watermark that came back empty causes a
 * visible re-ship storm, while a floor that came back empty causes a repair to
 * simply never happen — every signal reads clean and the row stays gone.
 *
 * So this assembles the real pieces: a real SQLite file, the real
 * `SqliteAppSyncableApplier` over a real app table, the real per-app state
 * store, and a restart that closes the database and opens it again. The floor
 * has to be armed by `verify()` rather than written by the test — a hand-written
 * map would prove the store persists JSON, not that a repair survives a reboot.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHLCClock, serializeHLC } from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
  type RawDatabase,
} from "@starkeep/storage-adapter";
// Source rather than `dist/`, the convention `sync-supervisor.ts` and
// `digest-failure.test.ts` both follow: a stale build would let these pass
// against the behaviour they exist to rule out.
import { SqliteDatabaseAdapter } from "../../../packages/storage-sqlite/src/adapter.js";
import { nodeSqliteDriver } from "../../../packages/storage-sqlite/src/node-driver.js";
import { SqliteAppSyncableApplier } from "../../../packages/storage-sqlite/src/app-syncable/apply.js";
import { createSqliteSyncStateStore } from "../../../packages/sync-engine/src/sync-state-sqlite.js";
import { createSyncEngine } from "../../../packages/sync-engine/src/sync-engine.js";
import { createInProcessSyncTransport } from "../../../packages/sync-engine/src/transports/in-process-transport.js";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
} from "../../../packages/sync-engine/src/types.js";
import { createPerAppSyncStateStore } from "../per-app-sync-state-store.js";

const APP = "notes";
const TABLE = "note";
/** `appSyncableTableName` for the pair above; the applier does not export it. */
const FULL_NAME = "notes_syncable_note";
const AUTHOR = "cloud";

function namespaceStore(): AppSyncableNamespaceStore {
  const ns: AppSyncableNamespace = {
    appId: APP,
    tables: [{ name: TABLE, pkColumns: ["id"] }],
    filesEnabled: false,
    tableNames: [TABLE],
  };
  return { get: (id) => (id === APP ? ns : null), list: () => [ns] };
}

function createAppTable(db: RawDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${FULL_NAME} (
       id TEXT PRIMARY KEY, payload TEXT,
       updated_at TEXT, deleted_at TEXT, node_id TEXT
     )`,
  );
}

function rowIds(db: RawDatabase): string[] {
  return (db.prepare(`SELECT id FROM ${FULL_NAME} ORDER BY id`).all() as Array<{
    id: string;
  }>).map((r) => r.id);
}

describe("a repair floor across a restart", () => {
  let dir: string;
  let dbPath: string;
  let cloudAdapter: SqliteDatabaseAdapter;
  let localAdapter: SqliteDatabaseAdapter | null = null;

  /** The peer: an app channel whose rows the local side is meant to hold. */
  async function startCloud(rowCount: number) {
    cloudAdapter = new SqliteDatabaseAdapter({ path: ":memory:", driver: nodeSqliteDriver });
    await cloudAdapter.init();
    const raw = cloudAdapter.getRawDatabase();
    createAppTable(raw);
    for (let i = 0; i < rowCount; i += 1) {
      raw
        .prepare(
          `INSERT INTO ${FULL_NAME} (id, payload, updated_at, node_id) VALUES (?, ?, ?, ?)`,
        )
        .run(
          `r${i}`,
          `payload-${i}`,
          serializeHLC({ wallTime: 1000 + i, counter: 0, nodeId: AUTHOR }),
          AUTHOR,
        );
    }
    const shared = new MockDatabaseAdapter();
    const storage = new MockObjectStorageAdapter();
    await shared.init();
    await storage.init();
    return {
      storage,
      transport: createInProcessSyncTransport({
        databaseAdapter: shared,
        clock: createHLCClock({ nodeId: AUTHOR }),
        objectStorage: storage,
        syncSharedRecords: false,
        appSyncableSource: {
          namespaces: namespaceStore(),
          applier: new SqliteAppSyncableApplier(raw, namespaceStore()),
        },
      }),
    };
  }

  /**
   * Open (or re-open) the local node on the same file. Everything durable — the
   * app rows, the watermarks, the floors — comes back from disk; everything
   * else is built fresh, exactly as a process restart would.
   */
  async function openLocal(cloud: Awaited<ReturnType<typeof startCloud>>) {
    localAdapter = new SqliteDatabaseAdapter({ path: dbPath, driver: nodeSqliteDriver });
    await localAdapter.init();
    const raw = localAdapter.getRawDatabase();
    createAppTable(raw);

    const syncState = createPerAppSyncStateStore(
      raw,
      createSqliteSyncStateStore({ db: raw }),
      APP,
    );
    const sharedRecords = new MockDatabaseAdapter();
    const storage = new MockObjectStorageAdapter();
    await sharedRecords.init();
    await storage.init();
    const engine = createSyncEngine({
      localDatabaseAdapter: sharedRecords,
      localObjectStorage: storage,
      remoteObjectStorage: cloud.storage,
      transport: cloud.transport,
      clock: createHLCClock({ nodeId: "device" }),
      syncState,
      syncSharedRecords: false,
      appSyncableSource: {
        namespaces: namespaceStore(),
        applier: new SqliteAppSyncableApplier(raw, namespaceStore()),
      },
    });
    return { engine, syncState, raw };
  }

  async function restart(cloud: Awaited<ReturnType<typeof startCloud>>) {
    await localAdapter?.close();
    localAdapter = null;
    return openLocal(cloud);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "starkeep-floor-restart-"));
    dbPath = join(dir, "data.db");
  });

  afterEach(async () => {
    await localAdapter?.close();
    localAdapter = null;
    await cloudAdapter?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("survives a restart and repairs the hole it was armed for", async () => {
    const cloud = await startCloud(6);
    const first = await openLocal(cloud);
    await first.engine.sync();
    expect(rowIds(first.raw)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);

    // Lose a row from the middle, behind the node's back. Its coverage
    // watermark is a MAX over the table, so the loss does not move it and the
    // peer goes on believing the row is held.
    first.raw.prepare(`DELETE FROM ${FULL_NAME} WHERE id = ?`).run("r2");

    // An ordinary round is blind to it — the control that makes the rest mean
    // something. If a plain sync refilled the hole, the floor would be doing no
    // work and its survival would prove nothing.
    await first.engine.sync();
    expect(rowIds(first.raw)).not.toContain("r2");

    const found = await first.engine.verify();
    expect(found.supported).toBe(true);
    expect(found.missingLocally).toBeGreaterThan(0);
    const armed = await first.syncState.getInboundFloors();
    expect(Object.keys(armed)).toEqual([AUTHOR]);

    // Reboot before the repair ever runs — the case that matters, since a
    // repair is armed by a person pressing a button and carried out by a later
    // tick, and a phone can easily be put down in between.
    const after = await restart(cloud);
    expect(
      await after.syncState.getInboundFloors(),
      "the floor must come back with the repair still outstanding",
    ).toEqual(armed);

    await after.engine.sync();
    expect(rowIds(after.raw), "the lost row comes back after the restart").toContain("r2");

    // …and the floor retires, so the channel is not left re-scanning that range
    // from the bottom forever.
    expect(await after.syncState.getInboundFloors()).toEqual({});
    expect((await after.engine.verify()).missingLocally).toBe(0);
  });

  it("comes back under its own channel's key, not another's", async () => {
    // The scoping and the durability are separate mechanisms and both have to
    // hold at once: a floor that persists under an unscoped key would repair
    // the wrong channel after a restart, which is worse than losing it.
    const cloud = await startCloud(4);
    const first = await openLocal(cloud);
    await first.engine.sync();
    first.raw.prepare(`DELETE FROM ${FULL_NAME} WHERE id = ?`).run("r1");
    await first.engine.verify();
    expect(Object.keys(await first.syncState.getInboundFloors())).toHaveLength(1);

    const after = await restart(cloud);
    const other = createPerAppSyncStateStore(
      after.raw,
      createSqliteSyncStateStore({ db: after.raw }),
      "photos",
    );
    expect(await other.getInboundFloors()).toEqual({});
    expect(await other.getRepairFloors()).toEqual({});
    expect(Object.keys(await after.syncState.getInboundFloors())).toHaveLength(1);
  });

  it("keeps an outbound repair floor across the restart too", async () => {
    // The other direction, armed by the peer being short rather than us. It
    // rides the same store and the same key discipline, and a test that only
    // covered the inbound cursor would leave half the mechanism unpinned.
    const cloud = await startCloud(5);
    const first = await openLocal(cloud);
    await first.engine.sync();
    await first.syncState.setRepairFloors({
      [AUTHOR]: { wallTime: 1001, counter: 0, nodeId: AUTHOR },
    });

    const after = await restart(cloud);
    expect(await after.syncState.getRepairFloors()).toEqual({
      [AUTHOR]: { wallTime: 1001, counter: 0, nodeId: AUTHOR },
    });
  });
});
