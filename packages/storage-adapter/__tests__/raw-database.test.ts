/**
 * The narrowed database interface (item 10).
 *
 * The point of the narrowing is that a **second driver can exist** — op-sqlite
 * on React Native, where `node:sqlite` does not. So the test that matters is
 * not "does DatabaseSync still work" but "can something that is emphatically
 * not DatabaseSync satisfy every consumer". The fake below implements only the
 * five methods in the interface and nothing else; if a consumer ever reaches
 * for `close`, `open`, or any other `DatabaseSync` member, this stops
 * compiling — which is the whole guarantee.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { RawDatabase, RawStatement } from "../src/database/raw-database.js";

/**
 * A driver with no relationship to node:sqlite whatsoever.
 *
 * Deliberately backed by plain arrays rather than by SQLite: something that
 * wrapped a real connection could satisfy the interface by accident, through a
 * member the interface does not name. This can only satisfy it on purpose.
 */
function fakeDriver(): RawDatabase & { readonly executed: string[] } {
  const executed: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  return {
    executed,
    exec(sql: string): void {
      executed.push(sql);
    },
    prepare(sql: string): RawStatement {
      executed.push(sql);
      return {
        run(...params: unknown[]) {
          rows.push({ sql, params });
          return { changes: 1 };
        },
        get(...params: unknown[]) {
          return rows.find((r) => JSON.stringify(r.params) === JSON.stringify(params));
        },
        all() {
          return [...rows];
        },
      };
    },
  };
}

describe("a driver that is not node:sqlite", () => {
  it("satisfies the interface without implementing anything else", () => {
    // Assigning it to the interface is the assertion: it compiles only because
    // the surface is genuinely limited to exec/prepare and run/get/all.
    const db: RawDatabase = fakeDriver();
    db.exec("CREATE TABLE t (a TEXT)");
    db.prepare("INSERT INTO t VALUES (?)").run("x");
    expect(db.prepare("SELECT * FROM t").all()).toHaveLength(1);
  });
});

describe("node:sqlite still satisfies it structurally", () => {
  // No wrapper, no adapter object, no behaviour change — the narrowing is a
  // restriction on what callers may reach for, not a new thing in the path.
  it("accepts a real DatabaseSync with no conversion", () => {
    const real: RawDatabase = new DatabaseSync(":memory:");
    real.exec("CREATE TABLE t (a INTEGER)");
    real.prepare("INSERT INTO t VALUES (?)").run(42);
    const row = real.prepare("SELECT a FROM t").get() as { a: number };
    expect(row.a).toBe(42);
  });

  it("round-trips through the same calls the sync engine makes", () => {
    const db: RawDatabase = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE blobs (key TEXT PRIMARY KEY, size INTEGER, pinned INTEGER)");
    const insert = db.prepare("INSERT INTO blobs VALUES (?, ?, ?)");
    insert.run("a", 100, 0);
    insert.run("b", 200, 1);
    const all = db.prepare("SELECT key FROM blobs ORDER BY key").all() as Array<{ key: string }>;
    expect(all.map((r) => r.key)).toEqual(["a", "b"]);
  });
});
