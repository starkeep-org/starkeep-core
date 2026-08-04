import { describe, it, expect, beforeEach } from "vitest";
import { createHLCClock } from "@starkeep/protocol-primitives";
import type {
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableRowEntry,
} from "@starkeep/sync-engine";
import { DsqlAppSyncableApplier } from "../src/app-syncable/apply.js";
import type { DatabaseClient } from "../src/types.js";

function occConflict(): Error {
  return Object.assign(new Error("change conflicts with another transaction"), {
    code: "OC001",
  });
}

class FakeClient implements DatabaseClient {
  calls: { text: string; values?: unknown[] }[] = [];
  conflicts: Array<{ match: RegExp; remaining: number }> = [];

  conflictOnce(match: RegExp, times = 1) {
    this.conflicts.push({ match, remaining: times });
  }

  async query(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    const conflict = this.conflicts.find((c) => c.remaining > 0 && c.match.test(text));
    if (conflict) {
      conflict.remaining--;
      throw occConflict();
    }
    return { rows: [] };
  }

  async end() {}
}

const ns: AppSyncableNamespace = {
  appId: "notes",
  tables: [{ name: "note", pkColumns: ["id"] }],
  filesEnabled: false,
  tableNames: ["note"],
};

const namespaceStore: AppSyncableNamespaceStore = {
  get: (appId) => (appId === "notes" ? ns : null),
  list: () => [ns],
};

const clock = createHLCClock({ nodeId: "node-test" });

let client: FakeClient;
let applier: DsqlAppSyncableApplier;

beforeEach(() => {
  client = new FakeClient();
  applier = new DsqlAppSyncableApplier(client, namespaceStore);
});

function insertEntry(): AppSyncableRowEntry {
  const ts = clock.now();
  return {
    timestamp: ts,
    appId: "notes",
    table: "note",
    op: "insert",
    row: { id: "n1", body: "hi", updated_at: "0", deleted_at: null },
  };
}

describe("DsqlAppSyncableApplier OCC retry", () => {
  it("retries the LWW upsert past an OCC conflict", async () => {
    client.conflictOnce(/insert into/, 2);
    await applier.apply(insertEntry());
    const inserts = client.calls.filter((c) => /insert into/.test(c.text));
    expect(inserts).toHaveLength(3); // two conflicts + one that committed
  });

  it("does not retry a non-OCC error", async () => {
    client.query = async (text: string) => {
      client.calls.push({ text });
      throw Object.assign(new Error("boom"), { code: "42P01" }); // undefined_table
    };
    await expect(applier.apply(insertEntry())).rejects.toThrow("boom");
    expect(client.calls).toHaveLength(1);
  });
});

/**
 * The statements a delete and an update actually compile to.
 *
 * These are shape assertions, not semantics: there is no in-process Postgres in
 * this repo, so the *behaviour* of this SQL is pinned by the SQLite half of
 * `@starkeep/storage-adapter/conformance`, which runs the identical contract
 * against real SQL. What can be checked here is that the DSQL applier emits the
 * same shape — above all, that a key predicate is present at all.
 *
 * That is the thing worth pinning. Both appliers used to build a tombstone with
 * no `where`, which compiles to `UPDATE … WHERE updated_at < ?` and soft-deletes
 * every older row in the table.
 */
describe("DsqlAppSyncableApplier statement shape", () => {
  function sqlFor(match: RegExp): string {
    const call = client.calls.find((c) => match.test(c.text));
    if (!call) throw new Error(`no statement matched ${match}`);
    return call.text;
  }

  it("keys a delete on the row it names", async () => {
    await applier.apply({
      timestamp: clock.now(),
      appId: "notes",
      table: "note",
      op: "delete",
      row: { updated_at: "5" },
      where: { id: "n1" },
    });
    const sql = sqlFor(/update .*set/i);
    expect(sql).toMatch(/"id" = \$\d/);
    // …and still carries the LWW guard, so a stale tombstone is inert.
    expect(sql).toMatch(/"updated_at" < \$\d/);
  });

  it("refuses a delete that names no row", async () => {
    await expect(
      applier.apply({
        timestamp: clock.now(),
        appId: "notes",
        table: "note",
        op: "delete",
        row: { updated_at: "5" },
      }),
    ).rejects.toThrow(/carries no "where"/);
    expect(client.calls.filter((c) => /update/i.test(c.text))).toHaveLength(0);
  });

  it("refuses an update that names no row", async () => {
    await expect(
      applier.apply({
        timestamp: clock.now(),
        appId: "notes",
        table: "note",
        op: "update",
        row: { body: "clobbered", updated_at: "5" },
      }),
    ).rejects.toThrow(/carries no "where"/);
    expect(client.calls.filter((c) => /update/i.test(c.text))).toHaveLength(0);
  });

  it("treats a NULL updated_at as older than everything on an update", async () => {
    // The same guard `applyDelete` emits. A bare `<` is *unknown* against NULL
    // in Postgres, so a row with no position silently refused every update while
    // accepting every tombstone — the two halves of one LWW rule disagreeing.
    await applier.apply({
      timestamp: clock.now(),
      appId: "notes",
      table: "note",
      op: "update",
      row: { body: "new", updated_at: "5" },
      where: { id: "n1" },
    });
    const sql = sqlFor(/update .*set/i);
    expect(sql).toMatch(/"updated_at" is null/);
    expect(sql).toMatch(/"updated_at" < \$\d/);
  });

  it("guards the upsert on the incoming row being newer", async () => {
    await applier.apply(insertEntry());
    expect(sqlFor(/insert into/)).toMatch(
      /"excluded"\."updated_at" > "app_notes"\."note"\."updated_at"/,
    );
  });
});

describe("DsqlAppSyncableApplier scanSince", () => {
  it("reports no ceiling and no rows for a table with nothing owed", async () => {
    // getNodeWatermarks finds no authors, so no scan is even planned.
    const page = await applier.scanSince("notes", "note", {}, 100);
    expect(page.rows).toEqual([]);
    expect(page.truncated).toEqual({});
    expect(page.hasMore).toBe(false);
  });

  it("pins every planned author to null when the row read fails", async () => {
    const author = "device-9";
    let call = 0;
    client.query = async (text: string, values?: unknown[]) => {
      client.calls.push({ text, values: values ?? [] });
      call += 1;
      // First call is the grouped watermark read; let it report an author owing
      // something, then fail the range seek that follows.
      if (call === 1) {
        return { rows: [{ node_id: author, max_updated_at: `${"0".repeat(12)}:0000:${author}` }] };
      }
      throw new Error("read failed mid-scan");
    };

    const page = await applier.scanSince("notes", "note", {}, 100);
    expect(page.rows).toEqual([]);
    // Not `{}` — that is the wire value for "enumerated completely", and
    // claiming it here is what lets a round ship rows above the ones this scan
    // never reached. See `round-cut.ts`.
    expect(page.truncated).toEqual({ [author]: null });
    expect(page.hasMore).toBe(true);
  });
});

/**
 * Absent vs. unreadable, on the responder that actually serves the cloud.
 *
 * `[]` and `{}` are the wire values for "this table holds nothing". Using them
 * for "I could not read it" is what turned a revoked GRANT into a report that
 * the peer had lost its library — in whichever direction the digest comparison
 * happened to run. Postgres separates the two by SQLSTATE, so the applier reads
 * the code rather than swallowing everything.
 */
describe("DsqlAppSyncableApplier — absent vs. unreadable", () => {
  function failWith(err: Error): void {
    client.query = async () => {
      throw err;
    };
  }

  function missingRelation(): Error {
    return Object.assign(
      new Error('relation "app_notes.note" does not exist'),
      { code: "42P01" },
    );
  }

  it("answers [] and {} when the app is simply not installed here", async () => {
    failWith(missingRelation());
    expect(await applier.bucketDigest("notes", "note")).toEqual([]);
    expect(await applier.getNodeWatermarks("notes", "note")).toEqual({});
  });

  it("answers [] and {} for a missing schema too", async () => {
    // A per-app schema and its tables are created together at install, so an
    // app that was never installed here fails one level up.
    failWith(
      Object.assign(new Error('schema "app_notes" does not exist'), { code: "3F000" }),
    );
    expect(await applier.bucketDigest("notes", "note")).toEqual([]);
    expect(await applier.getNodeWatermarks("notes", "note")).toEqual({});
  });

  it("throws rather than reporting an unreadable table as an empty one", async () => {
    failWith(
      Object.assign(new Error("permission denied for table note"), { code: "42501" }),
    );
    await expect(applier.bucketDigest("notes", "note")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("throws from getNodeWatermarks too, and the failure reaches scanSince", async () => {
    // `scanSince` plans its authors from this map and reads it outside its own
    // catch, so a table that will not read cannot be mistaken for one with
    // nothing owed.
    failWith(
      Object.assign(new Error("permission denied for table note"), { code: "42501" }),
    );
    await expect(applier.getNodeWatermarks("notes", "note")).rejects.toThrow();
    await expect(applier.scanSince("notes", "note", {}, 100)).rejects.toThrow();
  });

  it("recognizes a missing relation with no SQLSTATE on the error", async () => {
    // Not every client surfaces `code`. Being wrong in this direction costs a
    // re-ship; being wrong in the other costs a false loss report.
    failWith(new Error('ERROR: relation "app_notes.note" does not exist'));
    expect(await applier.bucketDigest("notes", "note")).toEqual([]);
  });
});
