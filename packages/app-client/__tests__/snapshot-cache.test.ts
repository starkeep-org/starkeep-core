/**
 * The snapshot cache: when a copy answers, when it reloads, whose rows it
 * holds, and that app SQL cannot change it.
 *
 * The loader is a fake so each test controls exactly what the data server
 * would have returned and when. SQLite is real: the point of the helper is that
 * joins, `strftime` and window functions run, so faking the engine would test
 * nothing.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createSnapshotCache,
  SnapshotReadOnlyError,
  SnapshotTooLargeError,
  type SnapshotCacheQuery,
  type SnapshotRow,
  type SnapshotTable,
} from "../src/snapshot.js";

const TABLES: SnapshotTable[] = [
  {
    name: "sets",
    columns: [
      { name: "id", type: "text" },
      { name: "workout_id", type: "text" },
      { name: "reps", type: "integer" },
      { name: "weight", type: "real" },
      { name: "warmup", type: "boolean" },
      { name: "done_at", type: "timestamp" },
    ],
  },
  {
    name: "workouts",
    columns: [
      { name: "id", type: "text" },
      { name: "name", type: "text" },
      { name: "meta", type: "text" },
    ],
  },
];

const SETS: SnapshotRow[] = [
  {
    id: "s1",
    workout_id: "w1",
    reps: 5,
    weight: 100,
    warmup: false,
    done_at: "2026-11-02T10:00:00Z",
  },
  {
    id: "s2",
    workout_id: "w1",
    reps: 5,
    weight: 60,
    warmup: true,
    done_at: "2026-11-02T09:50:00Z",
  },
  {
    id: "s3",
    workout_id: "w2",
    reps: 8,
    weight: 80,
    warmup: false,
    done_at: "2026-11-10T10:00:00Z",
  },
];
const WORKOUTS: SnapshotRow[] = [
  { id: "w1", name: "Squat", meta: null },
  { id: "w2", name: "Bench", meta: null },
];

/** A loader whose rows the test can change, counting its calls per table. */
function fakeServer(initial: Record<string, SnapshotRow[]> = { sets: SETS, workouts: WORKOUTS }) {
  const data = { ...initial };
  const load = vi.fn(async (table: string) => [...(data[table] ?? [])]);
  return { data, load };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const COUNT_SETS = "SELECT count(*) AS n FROM sets";

function q(
  over: Partial<SnapshotCacheQuery> & Pick<SnapshotCacheQuery, "load">,
): SnapshotCacheQuery {
  return { scope: "u1", tables: ["sets"], sql: COUNT_SETS, maxAge: 60_000, ...over };
}

describe("running SQL over the copy", () => {
  it("runs joins, date math and window functions over typed columns", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES });
    const result = await cache.query(
      q({
        load,
        tables: ["sets", "workouts"],
        sql: `
          -- weekly volume per lift, warmups excluded
          SELECT w.name AS lift,
                 strftime('%Y-%W', s.done_at) AS week,
                 sum(s.reps * s.weight) AS volume,
                 rank() OVER (ORDER BY sum(s.reps * s.weight) DESC) AS place
          FROM sets s JOIN workouts w ON w.id = s.workout_id
          WHERE s.warmup = 0
          GROUP BY lift, week
          ORDER BY place`,
      }),
    );
    expect(result.rows).toEqual([
      { lift: "Bench", week: "2026-45", volume: 640, place: 1 },
      { lift: "Squat", week: "2026-44", volume: 500, place: 2 },
    ]);
  });

  it("stores a boolean as 1 or 0 and an object as JSON text, and ignores undeclared keys", async () => {
    const { load } = fakeServer({
      workouts: [{ id: "w1", name: "Row", meta: { tempo: "2-1-2" }, extra: "dropped" }],
    });
    const cache = createSnapshotCache({ tables: TABLES });
    const result = await cache.query(
      q({ load, tables: ["workouts"], sql: "SELECT * FROM workouts" }),
    );
    expect(result.rows).toEqual([{ id: "w1", name: "Row", meta: '{"tempo":"2-1-2"}' }]);

    const sets = createSnapshotCache({ tables: TABLES });
    const flags = await sets.query(
      q({ load: fakeServer().load, sql: "SELECT id, warmup FROM sets ORDER BY id" }),
    );
    expect(flags.rows.map((r) => r.warmup)).toEqual([0, 1, 0]);
  });

  it("answers a query over an empty table with its declared columns", async () => {
    const { load } = fakeServer({ sets: [] });
    const cache = createSnapshotCache({ tables: TABLES });
    const result = await cache.query(q({ load, sql: "SELECT sum(reps) AS total FROM sets" }));
    expect(result.rows).toEqual([{ total: null }]);
  });

  it("binds positional and named parameters", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES });
    const positional = await cache.query(
      q({ load, sql: "SELECT count(*) AS n FROM sets WHERE reps = ?", params: [5] }),
    );
    expect(positional.rows).toEqual([{ n: 2 }]);
    const named = await cache.query(
      q({ load, sql: "SELECT count(*) AS n FROM sets WHERE reps = :r", params: { r: 8 } }),
    );
    expect(named.rows).toEqual([{ n: 1 }]);
  });

  it("refuses an undeclared table before loading anything", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES });
    await expect(cache.query(q({ load, tables: ["secrets"] }))).rejects.toThrow(
      /"secrets" is not a declared table/,
    );
    expect(load).not.toHaveBeenCalled();
  });
});

describe("freshness", () => {
  it("reuses a snapshot within maxAge and reloads after it", async () => {
    const { data, load } = fakeServer();
    const t = clock();
    const cache = createSnapshotCache({ tables: TABLES, now: t.now });

    expect((await cache.query(q({ load }))).rows).toEqual([{ n: 3 }]);
    data.sets = [...SETS, { id: "s4", reps: 1 }];
    t.advance(60_000);
    expect((await cache.query(q({ load }))).rows).toEqual([{ n: 3 }]);
    expect(load).toHaveBeenCalledTimes(1);

    t.advance(1);
    expect((await cache.query(q({ load }))).rows).toEqual([{ n: 4 }]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reloads on every query when maxAge is zero", async () => {
    const { load } = fakeServer();
    const t = clock();
    const cache = createSnapshotCache({ tables: TABLES, now: t.now });
    await cache.query(q({ load, maxAge: 0 }));
    t.advance(1);
    await cache.query(q({ load, maxAge: 0 }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reloads a snapshot loaded before freshAfter, and keeps one loaded at or after it", async () => {
    const { data, load } = fakeServer();
    const t = clock();
    const cache = createSnapshotCache({ tables: TABLES, now: t.now });

    const first = await cache.query(q({ load }));
    t.advance(1_000);
    expect((await cache.query(q({ load, freshAfter: first.loadedAt }))).loadedAt).toBe(
      first.loadedAt,
    );
    expect(load).toHaveBeenCalledTimes(1);

    // The Refresh action: the floor moves to now.
    data.sets = [];
    const refreshed = await cache.query(q({ load, freshAfter: t.now() }));
    expect(refreshed.rows).toEqual([{ n: 0 }]);
    expect(refreshed.loadedAt).toBe(t.now());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reports the time the load started, not the time it finished", async () => {
    const t = clock(5_000);
    const load = vi.fn(async () => {
      t.advance(2_000);
      return SETS;
    });
    const cache = createSnapshotCache({ tables: TABLES, now: t.now });
    const result = await cache.query(q({ load }));
    expect(result.loadedAt).toBe(5_000);
  });
});

describe("cache keys and bounds", () => {
  it("never answers one scope from another scope's snapshot", async () => {
    const perUser: Record<string, SnapshotRow[]> = { u1: SETS, u2: [SETS[0]!] };
    let scopeOfLoad = "";
    const load = vi.fn(async () => perUser[scopeOfLoad]!);
    const cache = createSnapshotCache({ tables: TABLES });

    scopeOfLoad = "u1";
    expect((await cache.query(q({ load, scope: "u1" }))).rows).toEqual([{ n: 3 }]);
    scopeOfLoad = "u2";
    expect((await cache.query(q({ load, scope: "u2" }))).rows).toEqual([{ n: 1 }]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys by the set of tables, whatever their order", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES });
    await cache.query(q({ load, tables: ["sets", "workouts"] }));
    await cache.query(q({ load, tables: ["workouts", "sets", "sets"] }));
    expect(load).toHaveBeenCalledTimes(2); // one load of two tables
  });

  it("evicts the least recently used snapshot past maxEntries", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES, maxEntries: 2 });
    await cache.query(q({ load, scope: "a" }));
    await cache.query(q({ load, scope: "b" }));
    await cache.query(q({ load, scope: "a" })); // a is now the most recent
    await cache.query(q({ load, scope: "c" })); // evicts b
    expect(load).toHaveBeenCalledTimes(3);

    await cache.query(q({ load, scope: "a" }));
    expect(load).toHaveBeenCalledTimes(3);
    await cache.query(q({ load, scope: "b" }));
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("refuses a load past maxRows and caches nothing", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES, maxRows: 4 });
    await expect(cache.query(q({ load, tables: ["sets", "workouts"] }))).rejects.toBeInstanceOf(
      SnapshotTooLargeError,
    );
    await expect(cache.query(q({ load, tables: ["sets", "workouts"] }))).rejects.toBeInstanceOf(
      SnapshotTooLargeError,
    );
    expect(load.mock.calls.filter(([t]) => t === "sets")).toHaveLength(2);
  });

  it("tells the loader how many rows it may still return", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES, maxRows: 10 });
    await cache.query(q({ load, tables: ["sets", "workouts"] }));
    expect(load.mock.calls.map(([t, ctx]) => [t, ctx.remainingRows])).toEqual([
      ["sets", 10],
      ["workouts", 7],
    ]);
  });

  it("caches nothing when a load fails, so the next query retries", async () => {
    const load = vi
      .fn<SnapshotCacheQuery["load"]>()
      .mockRejectedValueOnce(new Error("data server down"))
      .mockResolvedValue(SETS);
    const cache = createSnapshotCache({ tables: TABLES });
    await expect(cache.query(q({ load }))).rejects.toThrow("data server down");
    expect((await cache.query(q({ load }))).rows).toEqual([{ n: 3 }]);
  });

  it("drops every snapshot on clear", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES });
    await cache.query(q({ load }));
    cache.clear();
    await cache.query(q({ load }));
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("concurrent queries", () => {
  function gatedLoader() {
    const gates: Array<() => void> = [];
    const load = vi.fn(
      () =>
        new Promise<SnapshotRow[]>((resolve) => {
          gates.push(() => resolve(SETS));
        }),
    );
    return { load, release: (i: number) => gates[i]!() };
  }

  it("share one in-flight load", async () => {
    const { load, release } = gatedLoader();
    const cache = createSnapshotCache({ tables: TABLES });
    const a = cache.query(q({ load }));
    const b = cache.query(q({ load }));
    await Promise.resolve();
    release(0);
    const [ra, rb] = await Promise.all([a, b]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(ra.loadedAt).toBe(rb.loadedAt);
  });

  it("start a second load when the floor is newer than the in-flight load", async () => {
    const { load, release } = gatedLoader();
    const t = clock();
    const cache = createSnapshotCache({ tables: TABLES, now: t.now });
    const older = cache.query(q({ load }));
    t.advance(500);
    const newer = cache.query(q({ load, freshAfter: t.now() }));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);

    // The newer load lands first; the older one must not replace it.
    release(1);
    const rNewer = await newer;
    release(0);
    const rOlder = await older;
    expect(rNewer.loadedAt).toBeGreaterThan(rOlder.loadedAt);
    expect(rOlder.rows).toEqual([{ n: 3 }]);

    const next = await cache.query(q({ load }));
    expect(next.loadedAt).toBe(rNewer.loadedAt);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("read-only", () => {
  it.each([
    ["UPDATE sets SET reps = 0"],
    ["DELETE FROM sets"],
    ["DROP TABLE sets"],
    ["ATTACH ':memory:' AS other"],
    ["PRAGMA query_only = 0"],
    ["/* a comment */ INSERT INTO sets (id) VALUES ('x')"],
  ])("refuses %s before it reaches SQLite", async (sql) => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES });
    await expect(cache.query(q({ load, sql }))).rejects.toBeInstanceOf(SnapshotReadOnlyError);
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses a WITH that leads into a write, and drops the snapshot it touched", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES });
    await cache.query(q({ load }));

    await expect(
      cache.query(q({ load, sql: "WITH doomed AS (SELECT id FROM sets) DELETE FROM sets" })),
    ).rejects.toThrow();

    // Whatever refused it — SQLite's authorizer where the runtime has one, the
    // change count where it does not — the copy still holds every row.
    expect((await cache.query(q({ load }))).rows).toEqual([{ n: 3 }]);
  });

  it("catches the write by the change count on a runtime with no authorizer", async () => {
    // Node 22, the Lambda runtime today, has no `setAuthorizer`. Hide it so
    // this path runs on whatever Node the suite uses.
    const proto = DatabaseSync.prototype as { setAuthorizer?: unknown };
    const original = proto.setAuthorizer;
    proto.setAuthorizer = undefined;
    try {
      const { load } = fakeServer();
      const cache = createSnapshotCache({ tables: TABLES });
      await cache.query(q({ load }));
      await expect(
        cache.query(q({ load, sql: "WITH doomed AS (SELECT id FROM sets) DELETE FROM sets" })),
      ).rejects.toBeInstanceOf(SnapshotReadOnlyError);

      // The touched copy is gone, so the next query reloads a whole one.
      expect((await cache.query(q({ load }))).rows).toEqual([{ n: 3 }]);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      proto.setAuthorizer = original;
    }
  });

  it("accepts a statement led by comments and whitespace", async () => {
    const { load } = fakeServer();
    const cache = createSnapshotCache({ tables: TABLES });
    const result = await cache.query(q({ load, sql: "\n  -- count\n  /* sets */ " + COUNT_SETS }));
    expect(result.rows).toEqual([{ n: 3 }]);
  });
});
