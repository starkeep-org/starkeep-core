/**
 * The parser's rules for joins, subqueries and column operands.
 *
 * Three tables stand in for any parent, child and grandchild an app declares:
 * `projects`, `tasks` (each in one project, optionally under a parent task) and
 * `comments` (each on one task). The conformance suite covers what the
 * compiled forms return on each engine; this covers what the grammar admits.
 */

import { describe, it, expect } from "vitest";
import {
  parseQuery,
  QueryParseError,
  MAX_SUBQUERY_DEPTH,
  type AggregateQuery,
  type AppTables,
  type QueryParams,
  type QueryTableSchema,
  type RowQuery,
} from "../src/query/index.js";
import { SYSTEM_COLUMNS } from "../src/app-syncable/columns.js";

function table(
  name: string,
  columns: Array<[string, QueryTableSchema["columns"][number]["type"], boolean?]>,
): QueryTableSchema {
  return {
    name,
    pkColumns: ["id"],
    columns: [
      { name: "id", type: "text", notNull: true, primaryKey: true },
      ...columns.map(([n, type, notNull]) => ({
        name: n,
        type,
        notNull: notNull ?? false,
        primaryKey: false,
      })),
      ...SYSTEM_COLUMNS,
    ],
    includable: [],
  };
}

const PROJECTS = table("projects", [
  ["name", "text"],
  ["archived_at", "timestamp"],
  ["budget", "integer"],
  ["photo", "blob"],
]);
const TASKS = table("tasks", [
  ["project_id", "text", true],
  ["parent_task_id", "text"],
  ["title", "text"],
  ["done", "boolean"],
  ["estimate", "bigint"],
  ["due", "timestamp"],
]);
const COMMENTS = table("comments", [
  ["task_id", "text", true],
  ["author", "text"],
]);

const SCHEMAS = new Map([PROJECTS, TASKS, COMMENTS].map((s) => [s.name, s]));

const TABLES: AppTables = {
  names: [...SCHEMAS.keys()],
  schemaOf(name) {
    const schema = SCHEMAS.get(name);
    if (!schema) throw new QueryParseError(`App "a" did not declare app-syncable table "${name}"`);
    return schema;
  },
};

type Params = Record<string, unknown>;

/** JSON-encode the structured parameters, as a client does. */
function encode(params: Params): QueryParams {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out as QueryParams;
}

function rows(params: Params, base = PROJECTS): RowQuery {
  const parsed = parseQuery(base, encode(params), { tables: TABLES });
  if (parsed.mode !== "rows") throw new Error("expected a row query");
  return parsed;
}

function groups(params: Params, base = PROJECTS): AggregateQuery {
  const parsed = parseQuery(base, encode(params), { tables: TABLES });
  if (parsed.mode !== "aggregate") throw new Error("expected an aggregate query");
  return parsed;
}

function rejects(params: Params, match: RegExp, base = PROJECTS): void {
  expect(() => parseQuery(base, encode(params), { tables: TABLES })).toThrow(QueryParseError);
  expect(() => parseQuery(base, encode(params), { tables: TABLES })).toThrow(match);
}

const TASKS_OF_PROJECT = {
  table: "tasks",
  kind: "left",
  on: { "tasks.project_id": { eq: { col: "projects.id" } } },
};

describe("join", () => {
  it("parses a join with a column-operand key", () => {
    const q = rows({ join: [TASKS_OF_PROJECT], select: "id,name,tasks.title" });
    expect(q.joins).toEqual([
      {
        table: "tasks",
        qualifier: "tasks",
        kind: "left",
        on: [{ kind: "compare", column: "tasks.project_id", op: "eq", other: "id" }],
      },
    ]);
    expect(q.select).toEqual(["id", "name", "tasks.title"]);
  });

  it("normalizes a qualified base-table name to the bare form", () => {
    const q = rows({ join: [TASKS_OF_PROJECT], select: "projects.id,id,projects.name" });
    expect(q.select).toEqual(["id", "name"]);
  });

  it("requires select whenever join is present", () => {
    rejects({ join: [TASKS_OF_PROJECT] }, /a query with join must name its columns in select/);
  });

  it("appends each joined table's primary key after the base table's", () => {
    const q = rows({
      join: [
        TASKS_OF_PROJECT,
        {
          table: "comments",
          kind: "inner",
          on: { "comments.task_id": { eq: { col: "tasks.id" } } },
        },
      ],
      select: "id",
      order: "name.asc",
    });
    expect(q.order.map((t) => t.column)).toEqual(["name", "id", "tasks.id", "comments.id"]);
  });

  it("keeps a literal filter inside on", () => {
    const q = rows(
      {
        join: [
          {
            table: "projects",
            kind: "left",
            on: {
              "projects.id": { eq: { col: "tasks.project_id" } },
              "projects.archived_at": null,
            },
          },
        ],
        select: "id,projects.name",
      },
      TASKS,
    );
    expect(q.joins[0]!.on).toContainEqual({
      column: "projects.archived_at",
      predicate: { op: "eq", value: null },
    });
  });

  it("accepts composite and inequality keys", () => {
    const q = rows({
      join: [
        {
          table: "tasks",
          kind: "inner",
          on: {
            "tasks.project_id": { eq: { col: "projects.id" } },
            "tasks.due": { gte: { col: "projects.archived_at" } },
          },
        },
      ],
      select: "id",
    });
    expect(q.joins[0]!.on).toHaveLength(2);
  });

  it("requires as for a table already in scope, and accepts a self-join with one", () => {
    rejects(
      {
        join: [{ table: "tasks", kind: "left", on: { "tasks.id": { eq: { col: "tasks.id" } } } }],
        select: "id",
      },
      /already in scope here; give the second use an "as"/,
      TASKS,
    );
    const q = rows(
      {
        join: [
          {
            table: "tasks",
            as: "parent",
            kind: "left",
            on: { "parent.id": { eq: { col: "tasks.parent_task_id" } } },
          },
        ],
        select: "id,parent.title",
      },
      TASKS,
    );
    expect(q.joins[0]!.qualifier).toBe("parent");
    expect(q.order.map((t) => t.column)).toEqual(["id", "parent.id"]);
  });

  it("refuses an as that names a table or is already in scope", () => {
    const join = (as: string) => ({
      join: [
        {
          table: "tasks",
          as,
          kind: "left",
          on: { [`${as}.id`]: { eq: { col: "tasks.parent_task_id" } } },
        },
      ],
      select: "id",
    });
    rejects(join("comments"), /"as" must not be a table name/, TASKS);
    rejects(join("Bad-Name"), /"as" must be a name of lowercase letters/, TASKS);
  });

  it("refuses an on with no column operand tying the joined table to an earlier one", () => {
    rejects(
      { join: [{ table: "tasks", kind: "inner", on: { "tasks.done": true } }], select: "id" },
      /must compare one of its columns with a column of an earlier table/,
    );
    rejects(
      {
        join: [
          { table: "tasks", kind: "inner", on: { "tasks.title": { eq: { col: "tasks.id" } } } },
        ],
        select: "id",
      },
      /must compare one of its columns with a column of an earlier table/,
    );
    rejects(
      {
        join: [
          {
            table: "tasks",
            kind: "inner",
            on: { "projects.name": { eq: { col: "projects.id" } } },
          },
        ],
        select: "id",
      },
      /must compare one of its columns with a column of an earlier table/,
    );
  });

  it("refuses an on that names a later join", () => {
    rejects(
      {
        join: [
          {
            table: "tasks",
            kind: "inner",
            on: { "tasks.id": { eq: { col: "comments.task_id" } } },
          },
          {
            table: "comments",
            kind: "inner",
            on: { "comments.task_id": { eq: { col: "tasks.id" } } },
          },
        ],
        select: "id",
      },
      /"comments" is not a table in scope here/,
    );
  });

  it("refuses a bare name inside on", () => {
    rejects(
      {
        join: [{ table: "tasks", kind: "inner", on: { project_id: { eq: { col: "id" } } } }],
        select: "id",
      },
      /needs its table: inside on and inside a subquery/,
    );
  });

  it("refuses the server's columns inside on", () => {
    for (const column of ["deleted_at", "updated_at"]) {
      rejects(
        {
          join: [
            {
              table: "tasks",
              kind: "inner",
              on: {
                "tasks.project_id": { eq: { col: "projects.id" } },
                [`tasks.${column}`]: null,
              },
            },
          ],
          select: "id",
        },
        column === "deleted_at" ? /owned by the server/ : /sync-internal column/,
      );
    }
  });

  it("refuses a malformed join", () => {
    rejects({ join: [], select: "id" }, /non-empty JSON array/);
    rejects({ join: { table: "tasks" }, select: "id" }, /non-empty JSON array/);
    rejects({ join: [{ ...TASKS_OF_PROJECT, kind: "right" }], select: "id" }, /"inner" or "left"/);
    rejects({ join: [{ ...TASKS_OF_PROJECT, using: "id" }], select: "id" }, /"using" is not one/);
    rejects({ join: [{ table: "tasks", kind: "inner" }], select: "id" }, /needs an on/);
    rejects({ join: [{ ...TASKS_OF_PROJECT, table: "notes" }], select: "id" }, /did not declare/);
  });

  it("accepts joined columns in where, order and select", () => {
    const q = rows({
      join: [TASKS_OF_PROJECT],
      select: "id,tasks.title",
      where: { "tasks.done": { is: false }, budget: { gt: 10 } },
      order: "tasks.due.desc.nullsfirst,name",
    });
    expect(q.where).toContainEqual({ column: "tasks.done", predicate: { op: "is", value: false } });
    expect(q.order[0]).toEqual({ column: "tasks.due", direction: "desc", nulls: "first" });
    expect(q.order[1]).toEqual({ column: "name", direction: "asc", nulls: "last" });
  });

  it("refuses a name whose qualifier is not in scope", () => {
    rejects({ select: "id,tasks.title" }, /"tasks" is not a table in scope here/);
    rejects({ where: { "tasks.title": "x" } }, /"tasks" is not a table in scope here/);
  });
});

describe("column operands and explicit operators", () => {
  it("compares two columns of the base table", () => {
    const q = rows({ where: { due: { lt: { col: "tasks.due" } } } }, TASKS);
    expect(q.where).toEqual([{ kind: "compare", column: "due", op: "lt", other: "due" }]);
  });

  it("treats explicit eq as the bare scalar", () => {
    expect(rows({ where: { name: { eq: "x" } } }).where).toEqual(
      rows({ where: { name: "x" } }).where,
    );
  });

  it("points a bare column operand to eq", () => {
    rejects({ where: { name: { col: "id" } } }, /needs an operator, such as/);
  });

  it("requires matching types, or two numeric types", () => {
    rejects({ where: { title: { eq: { col: "due" } } } }, /must share its column's type/, TASKS);
    expect(rows({ where: { estimate: { gte: { col: "estimate" } } } }, TASKS).where).toHaveLength(
      1,
    );
    const q = rows({
      join: [TASKS_OF_PROJECT],
      select: "id",
      where: { budget: { lt: { col: "tasks.estimate" } } },
    });
    expect(q.where).toEqual([
      { kind: "compare", column: "budget", op: "lt", other: "tasks.estimate" },
    ]);
  });

  it("refuses an ordered comparison of booleans and any comparison of blobs", () => {
    rejects({ where: { done: { lt: { col: "done" } } } }, /has no ordering/, TASKS);
    rejects({ where: { photo: { eq: { col: "photo" } } } }, /is a blob/);
  });

  it("refuses a column operand with extra fields", () => {
    rejects({ where: { name: { eq: { col: "name", x: 1 } } } }, /"x" is not one of them/);
  });

  it("parses literal not_in and refuses null inside it", () => {
    expect(rows({ where: { name: { not_in: ["a", "b"] } } }).where).toEqual([
      { column: "name", predicate: { op: "not_in", values: ["a", "b"] } },
    ]);
    rejects({ where: { name: { not_in: ["a", null] } } }, /not_in cannot hold null/);
    rejects({ where: { name: { not_in: [] } } }, /matches everything/);
  });

  it("points a null inside not_in to ne null, since not_in already keeps the null rows", () => {
    const params = encode({ where: { name: { not_in: ["a", null] } } });
    const parse = () => parseQuery(PROJECTS, params, { tables: TABLES });
    expect(parse).toThrow(/already keeps the rows where "name" is null/);
    expect(parse).toThrow(/\{"ne": null\}/);
    // `{"is": null}` beside `not_in` would keep only the null rows.
    expect(parse).not.toThrow(/"is": null/);
  });
});

describe("exists and not_exists", () => {
  const TASK_OF_PROJECT = { "tasks.project_id": { eq: { col: "projects.id" } } };

  it("parses a correlated subquery", () => {
    const q = rows({ where: { exists: [{ table: "tasks", where: TASK_OF_PROJECT }] } });
    expect(q.where).toEqual([
      {
        kind: "exists",
        negated: false,
        sub: {
          table: "tasks",
          qualifier: "tasks",
          where: [{ kind: "compare", column: "tasks.project_id", op: "eq", other: "id" }],
        },
      },
    ]);
  });

  it("ANDs every entry of the array, and reads not_exists as the negation", () => {
    const q = rows({
      where: {
        exists: [
          { table: "tasks", where: { ...TASK_OF_PROJECT, "tasks.done": true } },
          { table: "tasks", where: { ...TASK_OF_PROJECT, "tasks.done": false } },
        ],
        not_exists: [
          {
            table: "tasks",
            as: "late",
            where: { "late.project_id": { eq: { col: "projects.id" } } },
          },
        ],
      },
    });
    expect(
      q.where.map((t) =>
        "kind" in t ? `${t.kind}:${String(t.kind === "exists" && t.negated)}` : "",
      ),
    ).toEqual(["exists:false", "exists:false", "exists:true"]);
  });

  it("refuses an uncorrelated subquery", () => {
    rejects(
      { where: { exists: [{ table: "tasks", where: { "tasks.done": true } }] } },
      /must compare a column of "tasks" with a column of an enclosing table/,
    );
    rejects({ where: { exists: [{ table: "tasks" }] } }, /enclosing table/);
  });

  it("accepts a nested subquery that correlates through its parent", () => {
    const q = rows({
      where: {
        exists: [
          {
            table: "tasks",
            where: {
              ...TASK_OF_PROJECT,
              exists: [
                { table: "comments", where: { "comments.task_id": { eq: { col: "tasks.id" } } } },
              ],
            },
          },
        ],
      },
    });
    expect(q.where).toHaveLength(1);
  });

  it("refuses fields an exists subquery does not take", () => {
    for (const field of ["select", "order", "limit", "join"]) {
      rejects(
        { where: { exists: [{ table: "tasks", where: TASK_OF_PROJECT, [field]: "x" }] } },
        new RegExp(`"${field}" is not one of them`),
      );
    }
  });

  it("refuses a non-array or empty exists", () => {
    rejects({ where: { exists: { table: "tasks" } } }, /non-empty JSON array/);
    rejects({ where: { not_exists: [] } }, /non-empty JSON array/);
  });

  it("does not leak a subquery's qualifier outward", () => {
    rejects(
      {
        where: {
          exists: [{ table: "tasks", where: TASK_OF_PROJECT }],
          "tasks.done": true,
        },
      },
      /"tasks" is not a table in scope here/,
    );
  });

  it("accepts exists inside on", () => {
    const q = rows(
      {
        join: [
          {
            table: "projects",
            kind: "left",
            on: {
              "projects.id": { eq: { col: "tasks.project_id" } },
              exists: [
                {
                  table: "comments",
                  where: { "comments.task_id": { eq: { col: "tasks.id" } } },
                },
              ],
            },
          },
        ],
        select: "id",
      },
      TASKS,
    );
    expect(q.joins[0]!.on).toHaveLength(2);
  });

  it(`caps nesting at ${MAX_SUBQUERY_DEPTH} levels`, () => {
    const nest = (depth: number): Record<string, unknown> => {
      const q = `t${depth}`;
      const parent = depth === 1 ? "tasks" : `t${depth - 1}`;
      return {
        table: "tasks",
        as: q,
        where: {
          [`${q}.parent_task_id`]: { eq: { col: `${parent}.id` } },
          ...(depth < MAX_SUBQUERY_DEPTH + 1 ? { exists: [nest(depth + 1)] } : {}),
        },
      };
    };
    rejects({ where: { exists: [nest(1)] } }, /nest at most 4 levels deep/, TASKS);
    const shallow = (depth: number): Record<string, unknown> => ({
      table: "tasks",
      as: `t${depth}`,
      where: {
        [`t${depth}.parent_task_id`]: {
          eq: { col: `${depth === 1 ? "tasks" : `t${depth - 1}`}.id` },
        },
        ...(depth < MAX_SUBQUERY_DEPTH ? { exists: [shallow(depth + 1)] } : {}),
      },
    });
    expect(rows({ where: { exists: [shallow(1)] } }, TASKS).where).toHaveLength(1);
  });
});

describe("in and not_in with a subquery", () => {
  it("parses an uncorrelated in subquery", () => {
    const q = rows({
      where: {
        id: { in: { table: "tasks", select: "tasks.project_id", where: { "tasks.done": true } } },
      },
    });
    expect(q.where).toEqual([
      {
        kind: "in_subquery",
        column: "id",
        negated: false,
        sub: {
          table: "tasks",
          qualifier: "tasks",
          select: "tasks.project_id",
          where: [{ column: "tasks.done", predicate: { op: "eq", value: true } }],
        },
      },
    ]);
  });

  it("requires select to name one column of the subquery's own table", () => {
    rejects({ where: { id: { in: { table: "tasks" } } } }, /must select one column/);
    rejects({ where: { id: { in: { table: "tasks", select: "project_id" } } } }, /needs its table/);
    rejects(
      { where: { id: { in: { table: "tasks", select: "projects.id" } } } },
      /selects a column of its own table "tasks"/,
    );
  });

  it("requires the selected column to share the outer column's type", () => {
    rejects(
      { where: { id: { in: { table: "tasks", select: "tasks.due" } } } },
      /the two must share a type/,
    );
  });

  it("requires a NOT NULL select column for not_in", () => {
    rejects(
      {
        where: { id: { not_in: { table: "tasks", as: "child", select: "child.parent_task_id" } } },
      },
      /must select a NOT NULL column/,
      TASKS,
    );
    const q = rows({ where: { id: { not_in: { table: "tasks", select: "tasks.project_id" } } } });
    expect(q.where[0]).toMatchObject({ kind: "in_subquery", negated: true });
  });

  it("refuses a sync-internal select column, which would filter on it", () => {
    for (const column of ["node_id", "updated_at"]) {
      rejects(
        { where: { name: { in: { table: "tasks", select: `tasks.${column}` } } } },
        /sync-internal column/,
      );
    }
  });

  it("refuses fields an in subquery does not take", () => {
    rejects(
      { where: { id: { in: { table: "tasks", select: "tasks.project_id", order: "x" } } } },
      /"order" is not one of them/,
    );
  });
});

describe("aggregates over joins", () => {
  it("groups by a joined column and aggregates a joined column", () => {
    const q = groups({
      join: [TASKS_OF_PROJECT],
      select: "name,tasks.done",
      aggregate: { n: { fn: "count" }, latest: { fn: "max", col: "tasks.due" } },
      order: "tasks.done.desc,n.desc",
    });
    expect(q.groupBy).toEqual(["name", "tasks.done"]);
    expect(q.aggregates[1]).toEqual({
      name: "latest",
      fn: "max",
      col: "tasks.due",
      distinct: false,
    });
    expect(q.order).toEqual([
      { column: "tasks.done", direction: "desc", nulls: "last" },
      { column: "n", direction: "desc", nulls: "last" },
    ]);
    expect(q.joins).toHaveLength(1);
  });

  it("orders by a qualified base-table group key under its bare name", () => {
    const q = groups({
      select: "projects.name",
      aggregate: { n: { fn: "count" } },
      order: "projects.name.desc",
    });
    expect(q.order).toEqual([{ column: "name", direction: "desc", nulls: "last" }]);
  });

  it("refuses an aggregate output that collides with a group key", () => {
    rejects(
      {
        join: [TASKS_OF_PROJECT],
        select: "tasks.title",
        aggregate: { "tasks.title": { fn: "count" } },
      },
      /collides with a column/,
    );
  });
});

describe("the shared plane", () => {
  function sharedRejects(params: Params, match: RegExp): void {
    expect(() => parseQuery(PROJECTS, encode(params))).toThrow(match);
  }

  it("refuses every multi-table form without a table resolver", () => {
    sharedRejects({ join: [TASKS_OF_PROJECT], select: "id" }, /join applies to app tables only/);
    sharedRejects(
      { where: { exists: [{ table: "tasks", where: {} }] } },
      /exists applies to app tables only/,
    );
    sharedRejects(
      { where: { id: { in: { table: "tasks", select: "tasks.project_id" } } } },
      /applies to app tables only/,
    );
    sharedRejects(
      { where: { name: { eq: { col: "id" } } } },
      /column operand applies to app tables only/,
    );
    sharedRejects({ select: "tasks.title" }, /applies to app tables only/);
  });

  it("still accepts explicit eq, literal not_in and a qualified base-table name", () => {
    const parsed = parseQuery(
      PROJECTS,
      encode({ where: { name: { eq: "x" }, "projects.budget": { not_in: [1] } } }),
    );
    expect(parsed.where).toEqual([
      { column: "name", predicate: { op: "eq", value: "x" } },
      { column: "budget", predicate: { op: "not_in", values: [1] } },
    ]);
  });
});
