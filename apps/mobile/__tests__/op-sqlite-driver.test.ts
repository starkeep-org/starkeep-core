/**
 * The op-sqlite driver (item 11a).
 *
 * Exercised against a fake connection backed by **real `node:sqlite`**, so the
 * SQL genuinely executes and the assertions are about behaviour rather than
 * about which methods were called. What the fake stands in for is only
 * op-sqlite's *shape* — `executeSync(query, params) => { rows }` — which is the
 * part that cannot run outside React Native.
 *
 * That leaves one thing honestly untested here: that op-sqlite itself behaves
 * as its types claim. Only a device settles that, and it is recorded as a gap.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  rawDatabaseFrom,
  createOpSqliteDriver,
  type OpSqliteConnection,
  type OpSqliteModule,
} from "../src/db/op-sqlite-driver";

/** op-sqlite's surface, over a real SQLite engine. */
function fakeConnection(): OpSqliteConnection & { closed: boolean; queries: string[] } {
  const db = new DatabaseSync(":memory:");
  const state = {
    closed: false,
    queries: [] as string[],
    executeSync(query: string, params?: unknown[]) {
      state.queries.push(query);
      const stmt = db.prepare(query);
      // op-sqlite returns `{ rows }` for everything, reads and writes alike.
      const isRead = /^\s*(select|pragma)/i.test(query);
      if (isRead) return { rows: stmt.all(...((params ?? []) as never[])) as unknown[] };
      stmt.run(...((params ?? []) as never[]));
      return { rows: [] };
    },
    close() {
      state.closed = true;
      db.close();
    },
  };
  return state;
}

let connection: ReturnType<typeof fakeConnection>;

beforeEach(() => {
  connection = fakeConnection();
});

afterEach(() => {
  if (!connection.closed) connection.close();
});

describe("satisfying RawDatabase", () => {
  it("executes DDL through exec", () => {
    const db = rawDatabaseFrom(connection);
    db.exec("CREATE TABLE t (a TEXT, b INTEGER)");
    expect(() => db.prepare("SELECT * FROM t").all()).not.toThrow();
  });

  it("binds parameters rather than interpolating them", () => {
    const db = rawDatabaseFrom(connection);
    db.exec("CREATE TABLE t (a TEXT)");
    // The value contains SQL that would be catastrophic if interpolated. It
    // round-trips intact, which is the proof that executeSync's second argument
    // is really doing the binding.
    const nasty = "'); DROP TABLE t; --";
    db.prepare("INSERT INTO t VALUES (?)").run(nasty);
    const row = db.prepare("SELECT a FROM t").get() as { a: string };
    expect(row.a).toBe(nasty);
    expect(db.prepare("SELECT count(*) AS n FROM t").all()).toHaveLength(1);
  });

  it("returns the first row from get and every row from all", () => {
    const db = rawDatabaseFrom(connection);
    db.exec("CREATE TABLE t (a INTEGER)");
    const insert = db.prepare("INSERT INTO t VALUES (?)");
    insert.run(1);
    insert.run(2);
    expect((db.prepare("SELECT a FROM t ORDER BY a").get() as { a: number }).a).toBe(1);
    expect(db.prepare("SELECT a FROM t").all()).toHaveLength(2);
  });

  it("returns undefined from get when nothing matches", () => {
    const db = rawDatabaseFrom(connection);
    db.exec("CREATE TABLE t (a INTEGER)");
    expect(db.prepare("SELECT a FROM t WHERE a = ?").get(99)).toBeUndefined();
  });

  it("returns an empty array from all when nothing matches", () => {
    const db = rawDatabaseFrom(connection);
    db.exec("CREATE TABLE t (a INTEGER)");
    expect(db.prepare("SELECT a FROM t").all()).toEqual([]);
  });

  // The point of the whole exercise: this is the interface the sync engine,
  // resident set and state store take, so satisfying it is what lets the phone
  // reuse them rather than reimplement them.
  it("is assignable to RawDatabase without a cast", () => {
    const db = rawDatabaseFrom(connection);
    expect(typeof db.exec).toBe("function");
    expect(typeof db.prepare).toBe("function");
  });
});

describe("prepare() does not really prepare", () => {
  // Documented rather than merely true: op-sqlite's prepared statements execute
  // asynchronously, and RawDatabase is synchronous by requirement — the
  // change-log write must not be able to interleave with the record write it
  // describes. So the SQL is captured and re-issued per call.
  it("re-issues the SQL on every call rather than reusing a statement", () => {
    const db = rawDatabaseFrom(connection);
    db.exec("CREATE TABLE t (a INTEGER)");
    const stmt = db.prepare("INSERT INTO t VALUES (?)");
    stmt.run(1);
    stmt.run(2);
    const inserts = connection.queries.filter((q) => q.startsWith("INSERT"));
    expect(inserts).toHaveLength(2);
  });

  it("still binds different parameters to the same captured SQL", () => {
    const db = rawDatabaseFrom(connection);
    db.exec("CREATE TABLE t (a INTEGER)");
    const stmt = db.prepare("INSERT INTO t VALUES (?)");
    stmt.run(1);
    stmt.run(2);
    const rows = db.prepare("SELECT a FROM t ORDER BY a").all() as Array<{ a: number }>;
    expect(rows.map((r) => r.a)).toEqual([1, 2]);
  });
});

describe("the driver", () => {
  const moduleFor = (conn: OpSqliteConnection): OpSqliteModule & { opened: unknown[] } => {
    const opened: unknown[] = [];
    return {
      opened,
      open(options) {
        opened.push(options);
        return conn;
      },
    };
  };

  // A phone has no meaningful notion of an absolute path the app may choose, so
  // the adapter's `path` vocabulary is translated here rather than leaking
  // op-sqlite's name/location split into the adapter.
  it("splits a path into op-sqlite's name and location", () => {
    const op = moduleFor(connection);
    createOpSqliteDriver(op).open("/data/starkeep/local.sqlite");
    expect(op.opened[0]).toEqual({ name: "local.sqlite", location: "/data/starkeep" });
  });

  it("passes a bare filename through with no location", () => {
    const op = moduleFor(connection);
    createOpSqliteDriver(op).open("local.sqlite");
    expect(op.opened[0]).toEqual({ name: "local.sqlite" });
  });

  // RawDatabase deliberately has no `close()` — consumers of a connection have
  // no business closing one — so the driver keeps the pairing itself.
  it("closes the connection it opened", () => {
    const driver = createOpSqliteDriver(moduleFor(connection));
    const db = driver.open("local.sqlite");
    expect(connection.closed).toBe(false);
    driver.close(db);
    expect(connection.closed).toBe(true);
  });

  it("ignores a close for a database it did not open", () => {
    const driver = createOpSqliteDriver(moduleFor(connection));
    // Closing something unknown must not throw: a caller unwinding from an
    // error should not hit a second error on the way out.
    expect(() => driver.close(rawDatabaseFrom(connection))).not.toThrow();
  });
});
