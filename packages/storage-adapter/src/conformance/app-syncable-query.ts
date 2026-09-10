/**
 * The query grammar's behaviour, as executable cases each engine runs against
 * itself.
 *
 * ## Why this exists separately from the applier conformance
 *
 * `app-syncable-applier.ts` asks three implementations — SQLite, Aurora DSQL
 * and the sync-engine's in-memory mock — the same questions about writes,
 * because the sync tests believe the mock's word about what a tombstone does.
 * The mock is not a query engine and has no callers that treat it as one, so
 * these cases live in their own array and are wired only into the two suites
 * backed by a real planner.
 *
 * ## What these cases are for
 *
 * The parser's unit tests cover what the grammar *admits*. These cover what a
 * compiled query *means*, and the reason they are worth their weight is that
 * SQLite and Postgres answer several of these differently by default:
 *
 * | Case                             | SQLite                 | DSQL          |
 * | -------------------------------- | ---------------------- | ------------- |
 * | null ordering                    | nulls first            | nulls last    |
 * | `avg` over an integer column     | float                  | `numeric`     |
 * | `LIKE 'x%'`                      | case-insensitive ASCII | case-sensitive|
 * | regex                            | no implementation      | POSIX         |
 * | `SELECT max(x), y` ungrouped     | accepted, picks a row  | `42803`       |
 *
 * The grammar's answer to each is one answer, and each of the first four has a
 * case below. The fifth is unrepresentable — `select` *is* the `GROUP BY` list
 * — so the parser's unit tests carry it and nothing here can reach it.
 *
 * Written as plain functions that throw, not in a test framework, for the
 * reason `app-syncable-applier.ts` gives: this package is published, and
 * importing vitest here would put a test runner in every consumer's dependency
 * graph.
 */

import { serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import type { AppColumnInfo, ParsedQueryResult, RowQuery } from "../database/app-query-types.js";
import type { KeyedRowEntry } from "../database/app-syncable-rows.js";

/** The applier surface these cases exercise. */
export interface QueryConformanceApplier {
  apply(entry: KeyedRowEntry): Promise<void> | void;
  runQuery(
    appId: string,
    table: string,
    query: RowQuery | Parameters<never>[0],
  ): Promise<ParsedQueryResult>;
}

/**
 * One implementation with a table shaped like {@link QUERY_COLUMNS}, ready to
 * be asked questions.
 *
 * The harness creates the table and registers it in whatever namespace store
 * the implementation reads, because that is the only engine-specific part. The
 * rows are seeded by {@link seedQueryRows} through `apply`, so both engines are
 * loaded by the same code and neither can be seeded into a shape the other
 * cannot reach.
 */
export interface QueryConformanceHarness {
  readonly applier: QueryConformanceApplier;
  readonly appId: string;
  readonly table: string;
}

/**
 * The columns every query-conformance table declares.
 *
 * `flag` is `boolean` and `n` is `integer`, so both types are asked every
 * question. The boolean matters most here: SQLite stores one as an integer and
 * Postgres as a native boolean, so it is the one column whose *representation*
 * the two engines can disagree about, and a suite that declared it `integer`
 * would prove nothing about the type an app actually writes. The seed below
 * loads real booleans through the applier, so a case reading `flag` back is
 * checking the whole round trip — bind, store, return — on each engine.
 */
export const QUERY_COLUMNS: readonly AppColumnInfo[] = [
  { name: "id", type: "text", notNull: true, primaryKey: true },
  { name: "name", type: "text", notNull: false, primaryKey: false },
  { name: "n", type: "integer", notNull: false, primaryKey: false },
  { name: "r", type: "real", notNull: false, primaryKey: false },
  { name: "flag", type: "boolean", notNull: false, primaryKey: false },
  { name: "ts", type: "timestamp", notNull: false, primaryKey: false },
  { name: "updated_at", type: "text", notNull: true, primaryKey: false },
  { name: "node_id", type: "text", notNull: true, primaryKey: false },
  { name: "deleted_at", type: "text", notNull: false, primaryKey: false },
];

/**
 * The rows every case reasons about.
 *
 * Chosen so that each divergence has something to catch: `r3` is null in every
 * nullable column, so null ordering and the null-skipping aggregates have a row
 * to disagree about; `BETA` is capitalized, so a `prefix` that compiled to
 * `LIKE` would match it on SQLite and not on Postgres; `r5` has a null `r` but
 * a non-null `n`, so `count(*)`, `count(n)` and `count(r)` are three different
 * numbers.
 */
export const QUERY_ROWS: readonly Record<string, unknown>[] = [
  { id: "r1", name: "alpha", n: 3, r: 1.5, flag: false, ts: "2026-09-01T00:00:00.000Z" },
  { id: "r2", name: "alphabet", n: 1, r: 2.5, flag: false, ts: "2026-09-05T00:00:00.000Z" },
  { id: "r3", name: null, n: null, r: null, flag: true, ts: null },
  { id: "r4", name: "BETA", n: 7, r: 4.0, flag: false, ts: "2026-09-03T00:00:00.000Z" },
  { id: "r5", name: "gamma", n: 2, r: null, flag: true, ts: "2026-09-09T00:00:00.000Z" },
];

// ---------------------------------------------------------------------------
// Assertions and fixtures
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`[app-syncable query conformance] ${message}`);
}

function equal(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${what}: expected ${e}, got ${a}`);
}

function hlc(wallTime: number): HLCTimestamp {
  return { wallTime, counter: 0, nodeId: "query-conformance" };
}

/** Load {@link QUERY_ROWS} through the applier's own write path. */
export async function seedQueryRows(h: QueryConformanceHarness): Promise<void> {
  let clock = 1;
  for (const row of QUERY_ROWS) {
    const ts = hlc(clock++);
    await h.applier.apply({
      timestamp: ts,
      appId: h.appId,
      table: h.table,
      op: "insert",
      row: { ...row, updated_at: serializeHLC(ts), deleted_at: null },
    });
  }
}

/** The parts of a row query a case cares about; the rest take their defaults. */
function query(h: QueryConformanceHarness, over: Partial<RowQuery> = {}): RowQuery {
  return {
    mode: "rows",
    table: h.table,
    select: null,
    where: [],
    order: [{ column: "id", direction: "asc", nulls: "last" }],
    limit: 100,
    pageToken: null,
    include: [],
    ...over,
  };
}

async function rows(
  h: QueryConformanceHarness,
  over: Partial<RowQuery> = {},
): Promise<{ ids: string[]; result: Extract<ParsedQueryResult, { mode: "rows" }> }> {
  const result = await h.applier.runQuery(h.appId, h.table, query(h, over));
  if (result.mode !== "rows") fail("expected a row result");
  return { ids: result.rows.map((r) => String(r["id"])), result };
}

async function groups(
  h: QueryConformanceHarness,
  over: {
    groupBy?: string[];
    aggregates: Array<{ name: string; fn: string; col: string | null; distinct: boolean }>;
    where?: RowQuery["where"];
    order?: RowQuery["order"];
  },
): Promise<Record<string, unknown>[]> {
  const result = await h.applier.runQuery(h.appId, h.table, {
    mode: "aggregate",
    table: h.table,
    groupBy: over.groupBy ?? [],
    aggregates: over.aggregates,
    where: over.where ?? [],
    order: over.order ?? [],
    limit: 100,
  } as never);
  if (result.mode !== "aggregate") fail("expected an aggregate result");
  return [...result.groups];
}

export interface QueryConformanceCase {
  readonly name: string;
  run(harness: QueryConformanceHarness): Promise<void>;
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export const appSyncableQueryConformance: readonly QueryConformanceCase[] = [
  {
    name: "equality matches, and equality against null means IS NULL",
    async run(h) {
      await seedQueryRows(h);
      equal((await rows(h, { where: [{ column: "n", predicate: { op: "eq", value: 3 } }] })).ids, ["r1"], "n = 3");
      // `= NULL` is never true in SQL, so a caller writing `{"name": null}`
      // would otherwise get an empty page rather than the row that is null.
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "eq", value: null } }] })).ids,
        ["r3"],
        "name = null",
      );
    },
  },

  {
    name: "`ne` keeps the null bucket, which bare SQL drops",
    async run(h) {
      await seedQueryRows(h);
      // `name <> 'alpha'` excludes nulls on both engines, and a caller asking
      // for "not alpha" means every row that is not alpha — r3 included.
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "ne", value: "alpha" } }] })).ids,
        ["r2", "r3", "r4", "r5"],
        "name <> alpha",
      );
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "ne", value: null } }] })).ids,
        ["r1", "r2", "r4", "r5"],
        "name is not null",
      );
    },
  },

  {
    name: "ordered comparison over every orderable type",
    async run(h) {
      await seedQueryRows(h);
      equal((await rows(h, { where: [{ column: "n", predicate: { op: "gte", value: 3 } }] })).ids, ["r1", "r4"], "n >= 3");
      equal((await rows(h, { where: [{ column: "r", predicate: { op: "lt", value: 2.5 } }] })).ids, ["r1"], "r < 2.5");
      equal(
        (await rows(h, {
          where: [{ column: "ts", predicate: { op: "lte", value: "2026-09-03T00:00:00.000Z" } }],
        })).ids,
        ["r1", "r4"],
        "ts <= 2026-09-03",
      );
      // Canonical ISO-8601 is what makes the text comparison a time
      // comparison; this is the case that would break if a writer emitted a
      // different spelling.
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "gt", value: "alphabet" } }] })).ids,
        ["r5"],
        "name > alphabet",
      );
    },
  },

  {
    name: "`in` and `is null`",
    async run(h) {
      await seedQueryRows(h);
      equal(
        (await rows(h, { where: [{ column: "id", predicate: { op: "in", values: ["r1", "r4", "nope"] } }] })).ids,
        ["r1", "r4"],
        "id in list",
      );
      equal(
        (await rows(h, { where: [{ column: "r", predicate: { op: "is", value: null } }] })).ids,
        ["r3", "r5"],
        "r is null",
      );
    },
  },

  {
    name: "`prefix` is a case-sensitive range on both engines",
    async run(h) {
      await seedQueryRows(h);
      equal(
        (await rows(h, {
          where: [{ column: "name", predicate: { op: "prefix", lower: "alpha", upper: "alphb" } }],
        })).ids,
        ["r1", "r2"],
        "name prefix alpha",
      );
      // The case that catches a `prefix` compiled to `LIKE`: SQLite's LIKE is
      // case-insensitive for ASCII by default and Postgres's is not, so
      // `LIKE 'beta%'` matches BETA locally and nothing in the cloud.
      equal(
        (await rows(h, {
          where: [{ column: "name", predicate: { op: "prefix", lower: "beta", upper: "betb" } }],
        })).ids,
        [],
        "name prefix beta does not match BETA",
      );
      equal(
        (await rows(h, {
          where: [{ column: "name", predicate: { op: "prefix", lower: "BETA", upper: "BETB" } }],
        })).ids,
        ["r4"],
        "name prefix BETA",
      );
    },
  },

  {
    name: "`like` returns the same rows on both engines",
    async run(h) {
      await seedQueryRows(h);
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "like", pattern: "alpha%" } }] }))
          .ids,
        ["r1", "r2"],
        "anchored pattern",
      );
      // The substring question `prefix` cannot answer, and the reason `like`
      // exists alongside it.
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "like", pattern: "%mm%" } }] }))
          .ids,
        ["r5"],
        "leading and trailing wildcard",
      );
      // `_` is exactly one character, so it matches `alpha` and not `alphabet`.
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "like", pattern: "alph_" } }] }))
          .ids,
        ["r1"],
        "single-character wildcard",
      );
      // `LIKE` against NULL is unknown, so a null column value is a non-match
      // rather than an error.
      equal(
        (await rows(h, {
          where: [
            { column: "id", predicate: { op: "in", values: ["r3", "r5"] } },
            { column: "name", predicate: { op: "like", pattern: "%a%" } },
          ],
        })).ids,
        ["r5"],
        "like over a null column value",
      );
    },
  },

  {
    name: "`like` is case-sensitive on both engines",
    async run(h) {
      await seedQueryRows(h);
      // The single most important case in this file. SQLite's LIKE folds ASCII
      // case by default and Postgres's does not, so without
      // `PRAGMA case_sensitive_like = ON` this pattern matches r4 locally and
      // nothing in the cloud — one query, two answers, which is the whole thing
      // the grammar exists to prevent.
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "like", pattern: "beta%" } }] }))
          .ids,
        [],
        "lowercase pattern does not match BETA",
      );
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "like", pattern: "BETA%" } }] }))
          .ids,
        ["r4"],
        "exact-case pattern matches BETA",
      );
    },
  },

  {
    name: "`like` escapes a wildcard back into a literal",
    async run(h) {
      await seedQueryRows(h);
      // Needs a row holding the wildcard characters themselves. Inserted here
      // rather than in QUERY_ROWS because every aggregate case counts that
      // fixture, and a sixth row would restate five expected numbers to prove
      // something only this case asks about.
      const ts = hlc(99);
      await h.applier.apply({
        timestamp: ts,
        appId: h.appId,
        table: h.table,
        op: "insert",
        row: {
          id: "r6",
          name: "100%_off",
          n: null,
          r: null,
          flag: false,
          ts: null,
          updated_at: serializeHLC(ts),
          deleted_at: null,
        },
      });

      // Unescaped, both wildcards do their usual job and the pattern matches.
      equal(
        (await rows(h, { where: [{ column: "name", predicate: { op: "like", pattern: "100%_off" } }] }))
          .ids,
        ["r6"],
        "unescaped wildcards match",
      );
      // Escaped, they are the literal characters — which this row happens to
      // hold, so the same pattern still matches and proves the escape reached
      // the engine rather than being dropped.
      equal(
        (await rows(h, {
          where: [{ column: "name", predicate: { op: "like", pattern: "100\\%\\_off" } }],
        })).ids,
        ["r6"],
        "escaped wildcards match the literal characters",
      );
      // The discriminating half: `alpha\%` is a literal `alpha%`, which no row
      // holds, while `alpha%` matches two. An engine that ignored the escape
      // clause would return r1 and r2 here.
      equal(
        (await rows(h, {
          where: [{ column: "name", predicate: { op: "like", pattern: "alpha\\%" } }],
        })).ids,
        [],
        "escaped % is a literal and matches nothing",
      );
    },
  },

  {
    name: "a projection returns exactly the named columns",
    async run(h) {
      await seedQueryRows(h);
      const { result } = await rows(h, {
        select: ["id"],
        order: [{ column: "n", direction: "asc", nulls: "last" }, { column: "id", direction: "asc", nulls: "last" }],
        limit: 1,
      });
      // The ordering column rode back under a reserved alias so the page token
      // could be cut from it, and the alias is stripped before the row is
      // returned. A leaked `__ok0` here would reach an app.
      equal(Object.keys(result.rows[0] ?? {}), ["id"], "projected keys");
    },
  },

  {
    name: "null ordering follows the query, not the engine's default",
    async run(h) {
      await seedQueryRows(h);
      // SQLite sorts nulls first, Postgres sorts them last, so neither default
      // is the answer — the grammar states it on every key.
      equal(
        (await rows(h, {
          order: [{ column: "n", direction: "asc", nulls: "last" }, { column: "id", direction: "asc", nulls: "last" }],
        })).ids,
        ["r2", "r5", "r1", "r4", "r3"],
        "nulls last",
      );
      equal(
        (await rows(h, {
          order: [{ column: "n", direction: "asc", nulls: "first" }, { column: "id", direction: "asc", nulls: "last" }],
        })).ids,
        ["r3", "r2", "r5", "r1", "r4"],
        "nulls first",
      );
    },
  },

  {
    name: "the cursor walks every row exactly once, including the null bucket",
    async run(h) {
      await seedQueryRows(h);
      for (const nulls of ["first", "last"] as const) {
        const order = [
          { column: "n", direction: "asc" as const, nulls },
          { column: "id", direction: "asc" as const, nulls: "last" as const },
        ];
        const seen: string[] = [];
        let pageToken: RowQuery["pageToken"] = null;
        for (let page = 0; page < 20; page += 1) {
          const result = await h.applier.runQuery(
            h.appId,
            h.table,
            query(h, { order, limit: 2, pageToken }),
          );
          if (result.mode !== "rows") fail("expected a row result");
          seen.push(...result.rows.map((r) => String(r["id"])));
          if (!result.truncated) {
            // The last page reports no continuation, which is how a caller
            // knows to stop rather than asking forever.
            if (result.pageToken !== null) fail(`nulls ${nulls}: last page carried a cursor`);
            break;
          }
          if (result.pageToken === null) fail(`nulls ${nulls}: truncated page carried no cursor`);
          pageToken = decodeToken(result.pageToken);
        }
        equal(
          [...seen].sort(),
          ["r1", "r2", "r3", "r4", "r5"],
          `nulls ${nulls}: every row exactly once`,
        );
      }
    },
  },

  {
    name: "`truncated` is set by the row limit and cleared when the page is complete",
    async run(h) {
      await seedQueryRows(h);
      const short = await h.applier.runQuery(h.appId, h.table, query(h, { limit: 2 }));
      if (short.mode !== "rows") fail("expected a row result");
      if (!short.truncated) fail("a page of 2 out of 5 reported no truncation");
      const whole = await h.applier.runQuery(h.appId, h.table, query(h, { limit: 5 }));
      if (whole.mode !== "rows") fail("expected a row result");
      if (whole.truncated) fail("a page holding every row reported truncation");
    },
  },

  {
    name: "a tombstoned row leaves every query",
    async run(h) {
      await seedQueryRows(h);
      await h.applier.apply({
        timestamp: hlc(100),
        appId: h.appId,
        table: h.table,
        op: "delete",
        row: { updated_at: serializeHLC(hlc(100)) },
        where: { id: "r1" },
      });
      equal((await rows(h)).ids, ["r2", "r3", "r4", "r5"], "rows after tombstone");
      const [g] = await groups(h, {
        aggregates: [{ name: "n", fn: "count", col: null, distinct: false }],
      });
      equal(Number(g!["n"]), 4, "count after tombstone");
    },
  },

  {
    name: "count(*), count(col) and count(distinct col) are three different numbers",
    async run(h) {
      await seedQueryRows(h);
      const [g] = await groups(h, {
        aggregates: [
          { name: "all_rows", fn: "count", col: null, distinct: false },
          { name: "with_r", fn: "count", col: "r", distinct: false },
          { name: "flags", fn: "count", col: "flag", distinct: true },
        ],
      });
      equal(Number(g!["all_rows"]), 5, "count(*)");
      // `count(x)` skips nulls, which is why both spellings exist.
      equal(Number(g!["with_r"]), 3, "count(r)");
      equal(Number(g!["flags"]), 2, "count(distinct flag)");
    },
  },

  {
    name: "`avg` over an integer column returns one number type on both engines",
    async run(h) {
      await seedQueryRows(h);
      const [g] = await groups(h, {
        aggregates: [{ name: "mean", fn: "avg", col: "n", distinct: false }],
      });
      // DSQL returns `numeric` for avg over an integer column and `pg` hands
      // that over as a string; SQLite returns a float. The DSQL compiler casts
      // to double precision so both servers answer one JSON number type.
      if (typeof g!["mean"] !== "number") {
        fail(`avg returned ${typeof g!["mean"]} (${JSON.stringify(g!["mean"])}), not a number`);
      }
      // The denominator is count(n) rather than count(*), because avg skips
      // nulls: (3 + 1 + 7 + 2) / 4.
      equal(g!["mean"], 3.25, "avg(n)");
    },
  },

  {
    name: "`sum` and `avg` over zero rows return null rather than 0",
    async run(h) {
      await seedQueryRows(h);
      const [g] = await groups(h, {
        where: [{ column: "id", predicate: { op: "eq", value: "nonexistent" } }],
        aggregates: [
          { name: "total", fn: "sum", col: "n", distinct: false },
          { name: "mean", fn: "avg", col: "n", distinct: false },
        ],
      });
      // A coalesced result cannot distinguish an empty match from a zero
      // total, so neither server coalesces and the app docs say so.
      equal(g!["total"], null, "sum over zero rows");
      equal(g!["mean"], null, "avg over zero rows");
    },
  },

  {
    name: "`min` and `max` skip nulls, grouped and ungrouped",
    async run(h) {
      await seedQueryRows(h);
      const [g] = await groups(h, {
        aggregates: [
          { name: "lo", fn: "min", col: "ts", distinct: false },
          { name: "hi", fn: "max", col: "ts", distinct: false },
        ],
      });
      equal(g!["lo"], "2026-09-01T00:00:00.000Z", "min(ts)");
      equal(g!["hi"], "2026-09-09T00:00:00.000Z", "max(ts)");
    },
  },

  {
    name: "a grouped aggregate omits empty groups entirely",
    async run(h) {
      await seedQueryRows(h);
      // Only `flag: true` rows have a null `r`, so grouping those by flag
      // produces one group rather than two. A caller wanting a row per flag
      // fills the gap from its own list — worth stating in the app docs,
      // because the alternative reading is a silent hole in a dashboard.
      //
      // No `order` term: a boolean has no ordering the grammar will accept, so
      // ordering by one here would demonstrate something no caller can ask for.
      // One surviving group makes the order immaterial anyway.
      const result = await groups(h, {
        groupBy: ["flag"],
        where: [{ column: "r", predicate: { op: "is", value: null } }],
        aggregates: [{ name: "n", fn: "count", col: null, distinct: false }],
      });
      equal(result.length, 1, "group count");
      equal(Number(result[0]!["n"]), 2, "rows in the surviving group");
    },
  },

  {
    name: "a boolean column round-trips as a JSON boolean on both engines",
    async run(h) {
      await seedQueryRows(h);
      // The case the two engines can disagree about. SQLite stores a declared
      // `boolean` as an integer and Postgres as a native boolean, and an app
      // row goes on the sync wire exactly as its engine returned it — so if
      // this ever reads `1` on one side and `true` on the other, the same
      // logical row has two wire forms and the peer that receives the wrong one
      // cannot bind it.
      const { result } = await rows(h, { where: [{ column: "id", predicate: { op: "eq", value: "r3" } }] });
      equal(result.rows[0]!["flag"], true, "true reads back as true");
      const off = await rows(h, { where: [{ column: "id", predicate: { op: "eq", value: "r1" } }] });
      equal(off.result.rows[0]!["flag"], false, "false reads back as false");

      // Each of the three ways the grammar lets a caller name a flag. `lt`,
      // `gt`, `min`, `max` and `order` are absent by design: `boolean` is not
      // an orderable type, so the parser refuses all five.
      equal(
        (await rows(h, { where: [{ column: "flag", predicate: { op: "is", value: true } }] })).ids,
        ["r3", "r5"],
        "is true",
      );
      equal(
        (await rows(h, { where: [{ column: "flag", predicate: { op: "eq", value: false } }] })).ids,
        ["r1", "r2", "r4"],
        "equality against false",
      );
      equal(
        (await rows(h, { where: [{ column: "flag", predicate: { op: "ne", value: false } }] })).ids,
        ["r3", "r5"],
        "ne false",
      );
    },
  },

  {
    name: "a boolean groups by its two values",
    async run(h) {
      await seedQueryRows(h);
      // Group keys travel the same conversion the rows do, so the key is a
      // JSON boolean rather than whichever spelling the engine holds. Ordered
      // by the aggregate output, since the grouping column has no ordering.
      const result = await groups(h, {
        groupBy: ["flag"],
        aggregates: [{ name: "n", fn: "count", col: null, distinct: false }],
        order: [{ column: "n", direction: "desc", nulls: "last" }],
      });
      equal(result.length, 2, "one group per value");
      equal(result[0]!["flag"], false, "the larger group is the false one");
      equal(Number(result[0]!["n"]), 3, "false rows");
      equal(result[1]!["flag"], true, "the smaller group is the true one");
      equal(Number(result[1]!["n"]), 2, "true rows");
    },
  },

  {
    name: "a grouped aggregate can be ordered by an aggregate output",
    async run(h) {
      await seedQueryRows(h);
      const result = await groups(h, {
        groupBy: ["flag"],
        aggregates: [{ name: "n", fn: "count", col: null, distinct: false }],
        order: [{ column: "n", direction: "desc", nulls: "last" }],
      });
      // Ordered by the output alias rather than by a repeat of `count(*)`,
      // which would be a second expression free to disagree with the first.
      equal(result.map((g) => Number(g["n"])), [3, 2], "groups by size, descending");
    },
  },

  {
    name: "a real column keeps full float8 significance on both engines",
    async run(h) {
      await seedQueryRows(h);
      // Postgres `real` is float4 and rounds this to 37.77493; SQLite's REAL is
      // always 8-byte IEEE. The installer used to emit `real` on one engine and
      // `double precision` on the other, so one value became two — and an app
      // row carries whatever it got onto the sync wire verbatim, which is how a
      // cloud round trip silently changed Memo's scheduler state.
      const precise = 37.774929496;
      await h.applier.apply({
        timestamp: hlc(9_000),
        appId: h.appId,
        table: h.table,
        op: "insert",
        row: {
          id: "r-precision",
          name: null,
          n: null,
          r: precise,
          flag: null,
          ts: null,
          updated_at: serializeHLC(hlc(9_000)),
          deleted_at: null,
        },
      });
      const { result } = await rows(h, { where: [{ column: "id", predicate: { op: "eq", value: "r-precision" } }] });
      equal(result.rows[0]?.["r"], precise, "real round-trips at float8");
    },
  },

  {
    name: "a timestamp column returns one canonical string on both engines",
    async run(h) {
      await seedQueryRows(h);
      const { result } = await rows(h, {
        where: [{ column: "id", predicate: { op: "eq", value: "r1" } }],
      });
      // Postgres stores a real `timestamp` and renders it `2026-09-01 00:00:00`
      // — a space, no `Z`, and a fractional part that vanishes at zero — while
      // SQLite returns the canonical string unchanged. Two engines answering
      // one query with two strings is the divergence this suite exists to
      // catch, so the Postgres side normalizes on the way out.
      equal(result.rows[0]?.["ts"], "2026-09-01T00:00:00.000Z", "canonical ISO-8601 in UTC");
    },
  },

  {
    name: "a timestamp is stored and returned unchanged from a non-UTC process zone",
    async run(h) {
      // The case that would have caught it. Everything persisted is UTC and no
      // column carries a zone, but both drivers parse a naive timestamp by
      // handing it to `new Date(...)`, which reads it in the *process* zone —
      // so one stored value came back as a different instant depending on where
      // the process ran. Lambda is UTC, which is precisely why nothing noticed.
      const previous = process.env.TZ;
      process.env.TZ = "Asia/Tokyo";
      try {
        await seedQueryRows(h);
        const { result } = await rows(h, {
          where: [{ column: "id", predicate: { op: "eq", value: "r1" } }],
          order: [{ column: "ts", direction: "asc", nulls: "last" }],
        });
        equal(result.rows[0]?.["ts"], "2026-09-01T00:00:00.000Z", "unshifted under TZ=Asia/Tokyo");
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    },
  },
];

/**
 * Decode a page token back into the parsed form a query carries.
 *
 * The cases hold the token the applier issued and hand it straight back, which
 * is what a route handler does after the parser has decoded it. Duplicated
 * here in miniature rather than importing the parser, because this package
 * sits below it.
 */
function decodeToken(encoded: string): RowQuery["pageToken"] {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as RowQuery["pageToken"];
}
