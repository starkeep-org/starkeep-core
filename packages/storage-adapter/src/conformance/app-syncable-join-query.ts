/**
 * Joins, subqueries and column operands, as executable cases each engine runs
 * against itself.
 *
 * The cases share the harness of `app-syncable-query.ts`: each engine creates
 * the three tables of {@link JOIN_TABLES} beside the table under test and
 * registers them in its namespace store. The rows arrive through `apply`, so
 * both engines are loaded by the same code.
 *
 * The tables stand in for any parent, child and grandchild an app declares:
 *
 *   - `projects`: `p1` holds two live tasks, `p2` one, `p3` none, and `p4`
 *     only a tombstoned one.
 *   - `tasks`: `t2` sits under `t1`; `t3` holds null in every nullable column;
 *     `t4` is tombstoned.
 *   - `comments`: two on `t1`, one on `t2`.
 *
 * Each case builds its parsed query by hand, because this package sits below
 * the parser. The parser's own tests cover what the grammar admits.
 */

import { serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import type {
  AggregateQuery,
  AppColumnInfo,
  ParsedQueryResult,
  RowQuery,
} from "../database/app-query-types.js";
import type { KeyedRowEntry } from "../database/app-syncable-rows.js";

/** What the join cases need of a harness: an applier and the app the tables belong to. */
export interface JoinConformanceHarness {
  readonly applier: {
    apply(entry: KeyedRowEntry): Promise<void> | void;
    runQuery(
      appId: string,
      table: string,
      query: RowQuery | AggregateQuery,
    ): Promise<ParsedQueryResult>;
  };
  readonly appId: string;
}

const SYNC_COLUMNS: readonly AppColumnInfo[] = [
  { name: "updated_at", type: "text", notNull: true, primaryKey: false },
  { name: "node_id", type: "text", notNull: true, primaryKey: false },
  { name: "deleted_at", type: "text", notNull: false, primaryKey: false },
];

function col(name: string, type: AppColumnInfo["type"], notNull = false): AppColumnInfo {
  return { name, type, notNull, primaryKey: false };
}

const ID: AppColumnInfo = { name: "id", type: "text", notNull: true, primaryKey: true };

/** The three tables every engine creates for these cases, declared once. */
export const JOIN_TABLES: readonly {
  readonly name: string;
  readonly pkColumns: readonly string[];
  readonly columns: readonly AppColumnInfo[];
}[] = [
  {
    name: "projects",
    pkColumns: ["id"],
    columns: [
      ID,
      col("name", "text"),
      col("archived_at", "timestamp"),
      col("budget", "integer"),
      ...SYNC_COLUMNS,
    ],
  },
  {
    name: "tasks",
    pkColumns: ["id"],
    columns: [
      ID,
      col("project_id", "text", true),
      col("parent_task_id", "text"),
      col("title", "text"),
      col("done", "boolean"),
      col("estimate", "bigint"),
      col("due", "timestamp"),
      ...SYNC_COLUMNS,
    ],
  },
  {
    name: "comments",
    pkColumns: ["id"],
    columns: [ID, col("task_id", "text", true), col("author", "text"), ...SYNC_COLUMNS],
  },
];

const PROJECT_ROWS = [
  { id: "p1", name: "Apollo", archived_at: null, budget: 10 },
  { id: "p2", name: "Borealis", archived_at: "2026-09-01T00:00:00.000Z", budget: 20 },
  { id: "p3", name: "Cygnus", archived_at: null, budget: null },
  { id: "p4", name: "Draco", archived_at: null, budget: 5 },
];

const TASK_ROWS = [
  {
    id: "t1",
    project_id: "p1",
    parent_task_id: null,
    title: "plan",
    done: true,
    estimate: 5,
    due: "2026-09-02T00:00:00.000Z",
  },
  {
    id: "t2",
    project_id: "p1",
    parent_task_id: "t1",
    title: "build",
    done: false,
    estimate: 8,
    due: "2026-09-10T00:00:00.000Z",
  },
  {
    id: "t3",
    project_id: "p2",
    parent_task_id: null,
    title: "ship",
    done: null,
    estimate: null,
    due: null,
  },
  {
    id: "t4",
    project_id: "p4",
    parent_task_id: null,
    title: "gone",
    done: false,
    estimate: 1,
    due: "2026-09-04T00:00:00.000Z",
  },
];

const COMMENT_ROWS = [
  { id: "c1", task_id: "t1", author: "ann" },
  { id: "c2", task_id: "t1", author: "bob" },
  { id: "c3", task_id: "t2", author: "ann" },
];

function fail(message: string): never {
  throw new Error(`[app-syncable join conformance] ${message}`);
}

function equal(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${what}: expected ${e}, got ${a}`);
}

function hlc(wallTime: number): HLCTimestamp {
  return { wallTime, counter: 0, nodeId: "join-conformance" };
}

/** Load the three tables through the applier, then tombstone `t4`. */
export async function seedJoinRows(h: JoinConformanceHarness): Promise<void> {
  let clock = 1;
  for (const [table, rows] of [
    ["projects", PROJECT_ROWS],
    ["tasks", TASK_ROWS],
    ["comments", COMMENT_ROWS],
  ] as const) {
    for (const row of rows) {
      const ts = hlc(clock++);
      await h.applier.apply({
        timestamp: ts,
        appId: h.appId,
        table,
        op: "insert",
        row: { ...row, updated_at: serializeHLC(ts), deleted_at: null },
      });
    }
  }
  const ts = hlc(clock++);
  await h.applier.apply({
    timestamp: ts,
    appId: h.appId,
    table: "tasks",
    op: "delete",
    row: { updated_at: serializeHLC(ts) },
    where: { id: "t4" },
  });
}

type Term = RowQuery["where"][number];

const asc = (column: string) => ({ column, direction: "asc" as const, nulls: "last" as const });
const eq = (column: string, value: string | number | boolean | null): Term => ({
  column,
  predicate: { op: "eq", value },
});
const compare = (column: string, op: "eq" | "ne" | "lt" | "gt", other: string): Term => ({
  kind: "compare",
  column,
  op,
  other,
});

/** `tasks` joined to its project, as the base-`projects` queries spell it. */
const TASKS_OF_PROJECT = (kind: "inner" | "left", ...extra: Term[]) => ({
  table: "tasks",
  qualifier: "tasks",
  kind,
  on: [compare("tasks.project_id", "eq", "id"), ...extra],
});

/** A row query over `base`, ordered by every primary key in scope unless told otherwise. */
function query(base: string, over: Partial<RowQuery>): RowQuery {
  const joins = over.joins ?? [];
  return {
    mode: "rows",
    table: base,
    select: null,
    joins,
    where: [],
    order: [asc("id"), ...joins.map((j) => asc(`${j.qualifier}.id`))],
    limit: 100,
    pageToken: null,
    include: [],
    ...over,
  };
}

async function rows(
  h: JoinConformanceHarness,
  base: string,
  over: Partial<RowQuery>,
): Promise<Extract<ParsedQueryResult, { mode: "rows" }>> {
  const result = await h.applier.runQuery(h.appId, base, query(base, over));
  if (result.mode !== "rows") fail("expected a row result");
  return result;
}

/** The value of `keys` in each row, joined with "/", so a case reads as a list of pairs. */
async function pairs(
  h: JoinConformanceHarness,
  base: string,
  keys: readonly string[],
  over: Partial<RowQuery>,
): Promise<string[]> {
  const result = await rows(h, base, { select: [...keys], ...over });
  return result.rows.map((row) => keys.map((k) => String(row[k])).join("/"));
}

/** Decode a page token, as `app-syncable-query.ts` does for the same reason. */
function decodeToken(encoded: string): RowQuery["pageToken"] {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as RowQuery["pageToken"];
}

export interface JoinConformanceCase {
  readonly name: string;
  run(h: JoinConformanceHarness): Promise<void>;
}

export const appSyncableJoinConformance: readonly JoinConformanceCase[] = [
  {
    name: "an inner join pairs each parent with each live child",
    async run(h) {
      await seedJoinRows(h);
      equal(
        await pairs(h, "projects", ["id", "tasks.id"], { joins: [TASKS_OF_PROJECT("inner")] }),
        ["p1/t1", "p1/t2", "p2/t3"],
        "inner join",
      );
    },
  },

  {
    name: "a left join keeps the parent with no live child and nulls its columns",
    async run(h) {
      await seedJoinRows(h);
      // p4's only task is tombstoned, so the soft-delete filter inside `on`
      // leaves p4 unmatched rather than dropping it.
      equal(
        await pairs(h, "projects", ["id", "tasks.id", "tasks.title"], {
          joins: [TASKS_OF_PROJECT("left")],
        }),
        ["p1/t1/plan", "p1/t2/build", "p2/t3/ship", "p3/null/null", "p4/null/null"],
        "left join",
      );
    },
  },

  {
    name: "a filter in on keeps the unmatched parent, and the same filter in where drops it",
    async run(h) {
      await seedJoinRows(h);
      equal(
        await pairs(h, "projects", ["id", "tasks.id"], {
          joins: [TASKS_OF_PROJECT("left", eq("tasks.done", true))],
        }),
        ["p1/t1", "p2/null", "p3/null", "p4/null"],
        "filter in on",
      );
      equal(
        await pairs(h, "projects", ["id", "tasks.id"], {
          joins: [TASKS_OF_PROJECT("left")],
          where: [eq("tasks.done", true)],
        }),
        ["p1/t1"],
        "filter in where",
      );
    },
  },

  {
    name: "a self-join through as reads each task's parent",
    async run(h) {
      await seedJoinRows(h);
      equal(
        await pairs(h, "tasks", ["id", "parent.title"], {
          joins: [
            {
              table: "tasks",
              qualifier: "parent",
              kind: "left",
              on: [compare("parent.id", "eq", "parent_task_id")],
            },
          ],
        }),
        ["t1/null", "t2/plan", "t3/null"],
        "self-join",
      );
    },
  },

  {
    name: "a composite key with an inequality pairs each task with later tasks of its project",
    async run(h) {
      await seedJoinRows(h);
      equal(
        await pairs(h, "tasks", ["id", "later.id"], {
          joins: [
            {
              table: "tasks",
              qualifier: "later",
              kind: "inner",
              on: [
                compare("later.project_id", "eq", "project_id"),
                compare("later.due", "gt", "due"),
              ],
            },
          ],
        }),
        ["t1/t2"],
        "composite inequality key",
      );
    },
  },

  {
    name: "exists and not_exists test each parent against its live children",
    async run(h) {
      await seedJoinRows(h);
      const sub = {
        table: "tasks",
        qualifier: "tasks",
        where: [compare("tasks.project_id", "eq", "id")],
      };
      equal(
        await pairs(h, "projects", ["id"], { where: [{ kind: "exists", negated: false, sub }] }),
        ["p1", "p2"],
        "exists",
      );
      equal(
        await pairs(h, "projects", ["id"], { where: [{ kind: "exists", negated: true, sub }] }),
        ["p3", "p4"],
        "not_exists",
      );
    },
  },

  {
    name: "a nested exists reaches the grandchild",
    async run(h) {
      await seedJoinRows(h);
      equal(
        await pairs(h, "projects", ["id"], {
          where: [
            {
              kind: "exists",
              negated: false,
              sub: {
                table: "tasks",
                qualifier: "tasks",
                where: [
                  compare("tasks.project_id", "eq", "id"),
                  {
                    kind: "exists",
                    negated: false,
                    sub: {
                      table: "comments",
                      qualifier: "comments",
                      where: [
                        compare("comments.task_id", "eq", "tasks.id"),
                        eq("comments.author", "bob"),
                      ],
                    },
                  },
                ],
              },
            },
          ],
        }),
        ["p1"],
        "nested exists",
      );
    },
  },

  {
    name: "an exists inside on decides the match, not the row",
    async run(h) {
      await seedJoinRows(h);
      equal(
        await pairs(h, "tasks", ["id", "projects.name"], {
          joins: [
            {
              table: "projects",
              qualifier: "projects",
              kind: "left",
              on: [
                compare("projects.id", "eq", "project_id"),
                {
                  kind: "exists",
                  negated: false,
                  sub: {
                    table: "comments",
                    qualifier: "comments",
                    where: [compare("comments.task_id", "eq", "id")],
                  },
                },
              ],
            },
          ],
        }),
        ["t1/Apollo", "t2/Apollo", "t3/null"],
        "exists inside on",
      );
    },
  },

  {
    name: "in and not_in with a subquery are complements over a nullable column",
    async run(h) {
      await seedJoinRows(h);
      const sub = {
        table: "tasks",
        qualifier: "done_tasks",
        select: "done_tasks.id",
        where: [eq("done_tasks.done", true)],
      };
      equal(
        await pairs(h, "tasks", ["id"], {
          where: [{ kind: "in_subquery", column: "parent_task_id", negated: false, sub }],
        }),
        ["t2"],
        "in subquery",
      );
      // t1 and t3 have no parent. SQL's NOT IN alone would drop them; the
      // grammar's not_in keeps them, as ne keeps the null bucket.
      equal(
        await pairs(h, "tasks", ["id"], {
          where: [{ kind: "in_subquery", column: "parent_task_id", negated: true, sub }],
        }),
        ["t1", "t3"],
        "not_in subquery",
      );
      equal(
        await pairs(h, "tasks", ["id"], {
          where: [
            {
              kind: "in_subquery",
              column: "id",
              negated: false,
              sub: {
                table: "comments",
                qualifier: "comments",
                select: "comments.task_id",
                where: [eq("comments.author", "ann")],
              },
            },
          ],
        }),
        ["t1", "t2"],
        "in subquery over another table",
      );
    },
  },

  {
    name: "a literal not_in keeps the null bucket",
    async run(h) {
      await seedJoinRows(h);
      equal(
        await pairs(h, "tasks", ["id"], {
          where: [{ column: "parent_task_id", predicate: { op: "not_in", values: ["t1"] } }],
        }),
        ["t1", "t3"],
        "literal not_in",
      );
    },
  },

  {
    name: "a column operand compares across tables, and ne is the complement of eq over nulls",
    async run(h) {
      await seedJoinRows(h);
      const parent = {
        table: "tasks",
        qualifier: "parent",
        kind: "left" as const,
        on: [compare("parent.id", "eq", "parent_task_id")],
      };
      equal(
        await pairs(h, "tasks", ["id"], {
          joins: [parent],
          where: [compare("done", "eq", "parent.done")],
        }),
        [],
        "eq over nulls and a mismatch",
      );
      equal(
        await pairs(h, "tasks", ["id"], {
          joins: [parent],
          where: [compare("done", "ne", "parent.done")],
        }),
        ["t1", "t2", "t3"],
        "ne over nulls and a mismatch",
      );
      // A bigint against an integer: two numeric types compare as numbers.
      equal(
        await pairs(h, "tasks", ["id"], {
          joins: [
            {
              table: "projects",
              qualifier: "projects",
              kind: "inner",
              on: [compare("projects.id", "eq", "project_id")],
            },
          ],
          where: [compare("estimate", "lt", "projects.budget")],
        }),
        ["t1", "t2"],
        "bigint against integer",
      );
    },
  },

  {
    name: "a page token walks a to-many join exactly once",
    async run(h) {
      await seedJoinRows(h);
      const over: Partial<RowQuery> = {
        joins: [TASKS_OF_PROJECT("left")],
        select: ["id", "tasks.id"],
        order: [
          { column: "name", direction: "desc", nulls: "last" },
          asc("id"),
          { column: "tasks.id", direction: "desc", nulls: "last" },
        ],
      };
      const whole = (await rows(h, "projects", over)).rows.map(
        (r) => `${r["id"]}/${r["tasks.id"]}`,
      );
      const walked: string[] = [];
      let pageToken: RowQuery["pageToken"] = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await rows(h, "projects", { ...over, limit: 2, pageToken });
        walked.push(...result.rows.map((r) => `${r["id"]}/${r["tasks.id"]}`));
        if (!result.pageToken) break;
        pageToken = decodeToken(result.pageToken);
      }
      equal(whole, ["p4/null", "p3/null", "p2/t3", "p1/t2", "p1/t1"], "whole result");
      equal(walked, whole, "paged walk");
    },
  },

  {
    name: "a joined boolean, bigint and timestamp read back in one representation",
    async run(h) {
      await seedJoinRows(h);
      const result = await rows(h, "projects", {
        joins: [TASKS_OF_PROJECT("inner")],
        select: ["id", "tasks.done", "tasks.estimate", "tasks.due"],
        where: [eq("tasks.id", "t1")],
      });
      equal(
        result.rows,
        [
          {
            id: "p1",
            "tasks.done": true,
            "tasks.estimate": 5,
            "tasks.due": "2026-09-02T00:00:00.000Z",
          },
        ],
        "joined values",
      );
    },
  },

  {
    name: "an aggregate groups and aggregates over joined columns",
    async run(h) {
      await seedJoinRows(h);
      const aggregate: AggregateQuery = {
        mode: "aggregate",
        table: "projects",
        groupBy: ["name", "tasks.project_id"],
        aggregates: [
          { name: "n", fn: "count", col: null, distinct: false },
          { name: "latest", fn: "max", col: "tasks.due", distinct: false },
        ],
        joins: [TASKS_OF_PROJECT("inner")],
        where: [],
        order: [{ column: "tasks.project_id", direction: "desc", nulls: "last" }],
        limit: 100,
      };
      const result = await h.applier.runQuery(h.appId, "projects", aggregate);
      if (result.mode !== "aggregate") fail("expected an aggregate result");
      equal(
        result.groups,
        [
          { name: "Borealis", "tasks.project_id": "p2", n: 1, latest: null },
          { name: "Apollo", "tasks.project_id": "p1", n: 2, latest: "2026-09-10T00:00:00.000Z" },
        ],
        "grouped over a join",
      );
    },
  },
];
