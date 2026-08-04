/**
 * "That table isn't here" is not "that table is empty".
 *
 * Both used to come back as `[]` from `bucketDigest` and `{}` from
 * `getNodeWatermarks`, and the difference is the whole integrity check. `[]` is
 * the wire value for "this table holds nothing", so a table that exists and
 * will not read — a corrupt page, a lock, a column dropped underneath us —
 * reported every row it holds as a hole. Undercounting locally makes the peer's
 * rows look like our own loss and arms a full re-download; undercounting on the
 * responder makes the requester re-ship the library. Neither direction is
 * fail-safe, which is why this one method is allowed to throw.
 *
 * The unreadable table here is a *real* one: it exists, and its `updated_at`
 * column does not, so the digest's `substr(updated_at, …)` fails the way a
 * genuine read failure does. No injected throw — the point of these cases is
 * that the real applier performs the failure the engine's guards were written
 * for, which is what `round-budget.test.ts:1095` could not establish.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
} from "@starkeep/shared-space-api";
import { SqliteAppSyncableApplier } from "../src/app-syncable/apply.js";
import { appSyncableTableName } from "../src/app-syncable/namespace.js";

const APP = "unreadable-app";
const TABLE = "test_rows";

function namespaces(): AppSyncableNamespaceStore {
  const ns: AppSyncableNamespace = {
    appId: APP,
    tables: [{ name: TABLE, pkColumns: ["id"] }],
    filesEnabled: false,
    tableNames: [TABLE],
  };
  return { get: (id) => (id === APP ? ns : null), list: () => [ns] };
}

function healthyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const fullName = appSyncableTableName(APP, TABLE);
  db.exec(
    `CREATE TABLE ${fullName} (
       id TEXT PRIMARY KEY, payload TEXT,
       updated_at TEXT, deleted_at TEXT, node_id TEXT
     )`,
  );
  db.exec(
    `INSERT INTO ${fullName} (id, payload, updated_at, node_id)
     VALUES ('r1', 'a', '0000000003e8:0000:N', 'N'),
            ('r2', 'b', '0000000003e9:0000:N', 'N')`,
  );
  return db;
}

/** The table exists and holds rows; the column every read needs does not. */
function brokenDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const fullName = appSyncableTableName(APP, TABLE);
  db.exec(`CREATE TABLE ${fullName} (id TEXT PRIMARY KEY, payload TEXT)`);
  db.exec(`INSERT INTO ${fullName} (id, payload) VALUES ('r1', 'a'), ('r2', 'b')`);
  return db;
}

describe("SqliteAppSyncableApplier — unreadable vs. absent", () => {
  it("counts a healthy table", async () => {
    const applier = new SqliteAppSyncableApplier(healthyDb() as never, namespaces());
    const digest = await applier.bucketDigest(APP, TABLE);
    expect(digest.reduce((n, b) => n + b.count, 0)).toBe(2);
  });

  it("answers [] for a table that is not here at all", async () => {
    // The legitimate case the old catch existed for: the app is not installed
    // on this node, so it genuinely holds nothing.
    const db = new DatabaseSync(":memory:");
    const applier = new SqliteAppSyncableApplier(db as never, namespaces());
    expect(await applier.bucketDigest(APP, TABLE)).toEqual([]);
    expect(await applier.getNodeWatermarks(APP, TABLE)).toEqual({});
  });

  it("throws rather than reporting an unreadable table as an empty one", async () => {
    const applier = new SqliteAppSyncableApplier(brokenDb() as never, namespaces());
    await expect(applier.bucketDigest(APP, TABLE)).rejects.toThrow();
  });

  it("throws from getNodeWatermarks too, so scanSince cannot call it drained", async () => {
    // `scanSince` plans its authors from this map. A `{}` for an unreadable
    // table produced no scans, and the scan then answered "nothing owed, every
    // author complete" — which lets the round ship rows above the ones it never
    // read. The failure has to reach `scanSince`, and it does because the
    // watermark read sits outside its catch.
    const applier = new SqliteAppSyncableApplier(brokenDb() as never, namespaces());
    await expect(applier.getNodeWatermarks(APP, TABLE)).rejects.toThrow();
    await expect(applier.scanSince(APP, TABLE, {}, 10)).rejects.toThrow();
  });
});

/**
 * The LWW guard against a row with no position at all.
 *
 * `updated_at` is NOT NULL wherever the installer created the table, so this is
 * a table created some other way — and it is exactly the case where the two
 * halves of the LWW rule had drifted apart. `applyDelete` said
 * `updated_at IS NULL OR updated_at < ?` and tombstoned such a row; `applyUpdate`
 * said only `updated_at < ?`, which is *unknown* against NULL in SQL, so the
 * update was silently dropped. Same rule, opposite answers, no test either way.
 */
describe("SqliteAppSyncableApplier — a row with a NULL updated_at", () => {
  function dbWithNullTimestamp(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    const fullName = appSyncableTableName(APP, TABLE);
    db.exec(
      `CREATE TABLE ${fullName} (
         id TEXT PRIMARY KEY, payload TEXT,
         updated_at TEXT, deleted_at TEXT, node_id TEXT
       )`,
    );
    db.exec(`INSERT INTO ${fullName} (id, payload, node_id) VALUES ('r1', 'old', 'N')`);
    return db;
  }

  const later = "0000000003e8:0000:N";

  function readPayload(db: DatabaseSync): unknown {
    const rows = db
      .prepare(`SELECT payload, deleted_at FROM ${appSyncableTableName(APP, TABLE)} WHERE id = 'r1'`)
      .all() as Array<{ payload: string; deleted_at: string | null }>;
    return rows[0];
  }

  it("applies an update over it, as a delete already did", async () => {
    const db = dbWithNullTimestamp();
    const applier = new SqliteAppSyncableApplier(db as never, namespaces());
    await applier.apply({
      timestamp: { wallTime: 1000, counter: 0, nodeId: "N" },
      appId: APP,
      table: TABLE,
      op: "update",
      row: { payload: "new", updated_at: later },
      where: { id: "r1" },
    });
    expect((readPayload(db) as { payload: string }).payload).toBe("new");
  });

  it("still refuses an update that is genuinely older", async () => {
    // The guard has to keep doing its job: NULL is "older than everything", not
    // "apply anything".
    const db = new DatabaseSync(":memory:");
    const fullName = appSyncableTableName(APP, TABLE);
    db.exec(
      `CREATE TABLE ${fullName} (
         id TEXT PRIMARY KEY, payload TEXT,
         updated_at TEXT, deleted_at TEXT, node_id TEXT
       )`,
    );
    db.exec(
      `INSERT INTO ${fullName} (id, payload, updated_at, node_id)
       VALUES ('r1', 'current', '0000000003e9:0000:N', 'N')`,
    );
    const applier = new SqliteAppSyncableApplier(db as never, namespaces());
    await applier.apply({
      timestamp: { wallTime: 1000, counter: 0, nodeId: "N" },
      appId: APP,
      table: TABLE,
      op: "update",
      row: { payload: "stale", updated_at: later },
      where: { id: "r1" },
    });
    expect((readPayload(db) as { payload: string }).payload).toBe("current");
  });

  it("tombstones it on a delete, which is the behaviour update now matches", async () => {
    const db = dbWithNullTimestamp();
    const applier = new SqliteAppSyncableApplier(db as never, namespaces());
    await applier.apply({
      timestamp: { wallTime: 1000, counter: 0, nodeId: "N" },
      appId: APP,
      table: TABLE,
      op: "delete",
      row: { updated_at: later },
      where: { id: "r1" },
    });
    expect((readPayload(db) as { deleted_at: string | null }).deleted_at).toBe(later);
  });
});
