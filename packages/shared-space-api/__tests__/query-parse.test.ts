/**
 * The parser's rules, one rejection at a time.
 *
 * The parser is the only thing standing between an app-supplied string and two
 * SQL compilers, and it is deliberately pure — no SQL, no engine, no I/O — so
 * every rule it enforces is testable here without a database. The conformance
 * suite covers what the compiled query *does* on each engine; this covers what
 * the grammar admits.
 */

import { describe, it, expect } from "vitest";
import {
  parseQuery,
  QueryParseError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  encodePageToken,
  appOrderSignature,
  prefixUpperBound,
  type QueryTableSchema,
  type RowQuery,
  type AggregateQuery,
} from "../src/query/index.js";
import { SYSTEM_COLUMNS } from "../src/app-syncable/columns.js";

const CARD_STATE: QueryTableSchema = {
  name: "card_state",
  pkColumns: ["id"],
  columns: [
    { name: "id", type: "text", notNull: true, primaryKey: true },
    { name: "deck_id", type: "text", notNull: false, primaryKey: false },
    { name: "due", type: "timestamp", notNull: false, primaryKey: false },
    { name: "suspended", type: "boolean", notNull: false, primaryKey: false },
    { name: "reps", type: "integer", notNull: false, primaryKey: false },
    { name: "strength", type: "real", notNull: false, primaryKey: false },
    { name: "payload", type: "blob", notNull: false, primaryKey: false },
    ...SYSTEM_COLUMNS,
  ],
};

/** A registry row written before column types existed. */

const TS = "2026-09-09T00:00:00.000Z";

function rows(params: Parameters<typeof parseQuery>[1]): RowQuery {
  const parsed = parseQuery(CARD_STATE, params);
  if (parsed.mode !== "rows") throw new Error("expected a row query");
  return parsed;
}

function groups(params: Parameters<typeof parseQuery>[1]): AggregateQuery {
  const parsed = parseQuery(CARD_STATE, params);
  if (parsed.mode !== "aggregate") throw new Error("expected an aggregate query");
  return parsed;
}

function rejects(params: Parameters<typeof parseQuery>[1], match: RegExp): void {
  expect(() => parseQuery(CARD_STATE, params)).toThrow(QueryParseError);
  expect(() => parseQuery(CARD_STATE, params)).toThrow(match);
}

describe("where", () => {
  it("reads a scalar as equality and an object as operators", () => {
    const q = rows({ where: JSON.stringify({ deck_id: "d1", reps: { gte: 3 } }) });
    expect(q.where).toEqual([
      { column: "deck_id", predicate: { op: "eq", value: "d1" } },
      { column: "reps", predicate: { op: "gte", value: 3 } },
    ]);
  });

  it("ANDs several operators on one column", () => {
    const q = rows({ where: JSON.stringify({ due: { gte: TS, lt: "2026-10-01T00:00:00.000Z" } }) });
    expect(q.where.map((c) => c.predicate.op)).toEqual(["gte", "lt"]);
  });

  it("refuses a column the table does not declare", () => {
    rejects({ where: JSON.stringify({ nope: 1 }) }, /not a column of "card_state"/);
  });

  it("refuses JavaScript object notation rather than evaluating it", () => {
    rejects({ where: "{deck_id: 'd1'}" }, /where must be JSON/);
  });

  it("refuses an unknown operator", () => {
    rejects({ where: JSON.stringify({ reps: { matches: "x" } }) }, /not an operator/);
  });

  it("checks a value against the column's declared type", () => {
    rejects({ where: JSON.stringify({ reps: "3" }) }, /declared integer/);
    rejects({ where: JSON.stringify({ deck_id: 3 }) }, /declared text/);
    rejects({ where: JSON.stringify({ reps: 1.5 }) }, /whole number/);
  });

  it("accepts only canonical ISO-8601 for a timestamp column", () => {
    expect(rows({ where: JSON.stringify({ due: TS }) }).where).toHaveLength(1);
    rejects({ where: JSON.stringify({ due: "2026-09-09T00:00:00Z" }) }, /canonical ISO-8601/);
    rejects({ where: JSON.stringify({ due: "2026-09-09" }) }, /canonical ISO-8601/);
  });

  it("normalizes a boolean column's 0 and 1 to a real boolean", () => {
    const q = rows({ where: JSON.stringify({ suspended: 0 }) });
    expect(q.where[0]!.predicate).toEqual({ op: "eq", value: false });
    expect(rows({ where: JSON.stringify({ suspended: 1 }) }).where[0]!.predicate).toEqual({
      op: "eq",
      value: true,
    });
    // The spellings a JSON caller would reach for first, unchanged.
    expect(rows({ where: JSON.stringify({ suspended: true }) }).where[0]!.predicate).toEqual({
      op: "eq",
      value: true,
    });
    rejects({ where: JSON.stringify({ suspended: 2 }) }, /expected true, false, 0 or 1/);
    rejects({ where: JSON.stringify({ suspended: "true" }) }, /expected true, false, 0 or 1/);
  });

  it("refuses an ordered comparison against a boolean column", () => {
    // A flag has two values and no order worth asking for. `boolean` is not an
    // orderable type, so this is refused by the column's declaration rather
    // than by the JavaScript type of the value it normalized to — which is what
    // also gets `order` and `min`/`max` below.
    rejects({ where: JSON.stringify({ suspended: { gt: false } }) }, /has no ordering/);
    rejects({ where: JSON.stringify({ suspended: { lte: 1 } }) }, /has no ordering/);
  });

  it("takes null, true and false through `is`, and nothing else", () => {
    expect(rows({ where: JSON.stringify({ due: { is: null } }) }).where[0]!.predicate).toEqual({
      op: "is",
      value: null,
    });
    expect(
      rows({ where: JSON.stringify({ suspended: { is: true } }) }).where[0]!.predicate,
    ).toEqual({ op: "is", value: true });
    rejects({ where: JSON.stringify({ due: { is: "yes" } }) }, /is takes null, true or false/);
    // `is null` on a NOT NULL column matches nothing, which is a mistake rather
    // than a question.
    rejects({ where: JSON.stringify({ id: { is: null } }) }, /NOT NULL/);
  });

  it("takes an `in` list as a JSON array, so nothing needs comma-escaping", () => {
    const q = rows({ where: JSON.stringify({ deck_id: { in: ["a,b", "c"] } }) });
    expect(q.where[0]!.predicate).toEqual({ op: "in", values: ["a,b", "c"] });
    rejects({ where: JSON.stringify({ deck_id: { in: "a,b" } }) }, /in takes a JSON array/);
    rejects({ where: JSON.stringify({ deck_id: { in: [] } }) }, /matches nothing/);
  });

  it("refuses ordered comparison against null, and points at `is`", () => {
    rejects({ where: JSON.stringify({ due: { gte: null } }) }, /use \{"is": null\}/);
  });

  it("refuses a predicate on a blob column", () => {
    rejects({ where: JSON.stringify({ payload: "x" }) }, /blob and cannot appear in a predicate/);
  });

  it("refuses deleted_at outright and the other system columns in where", () => {
    rejects({ where: JSON.stringify({ deleted_at: null }) }, /owned by the server/);
    rejects({ where: JSON.stringify({ updated_at: "x" }) }, /select and order only/);
    rejects({ where: JSON.stringify({ node_id: "x" }) }, /select and order only/);
  });

  it("enforces a table's required filters", () => {
    const labels: QueryTableSchema = {
      name: "record_labels",
      pkColumns: ["record_id", "app_id", "key", "value"],
      requiredFilters: ["app_id", "key"],
      columns: [
        { name: "record_id", type: "text", notNull: true, primaryKey: true },
        { name: "app_id", type: "text", notNull: true, primaryKey: true },
        { name: "key", type: "text", notNull: true, primaryKey: true },
        { name: "value", type: "text", notNull: true, primaryKey: true },
      ],
    };
    expect(() =>
      parseQuery(labels, { where: JSON.stringify({ app_id: "photos" }) }),
    ).toThrow(/requires "app_id" and "key"/);
    expect(() =>
      parseQuery(labels, { where: JSON.stringify({ app_id: "photos", key: "person" }) }),
    ).not.toThrow();
  });
});

describe("prefix", () => {
  it("compiles to a half-open range rather than a pattern", () => {
    const q = rows({ where: JSON.stringify({ deck_id: { prefix: "photo-" } }) });
    expect(q.where[0]!.predicate).toEqual({ op: "prefix", lower: "photo-", upper: "photo." });
  });

  it("carries a wildcard character through as a literal", () => {
    // The value is a literal, so `%` and `_` in app data mean nothing and
    // nothing needs escaping — which is the classic LIKE bug this avoids.
    const q = rows({ where: JSON.stringify({ deck_id: { prefix: "100%_" } }) });
    expect(q.where[0]!.predicate).toMatchObject({ lower: "100%_" });
  });

  it("increments the last code point, carrying past ones with no successor", () => {
    expect(prefixUpperBound("ab")).toBe("ac");
    // A surrogate pair is one code point, so the successor stays a valid string.
    expect(prefixUpperBound("a\u{1F600}")).toBe("a\u{1F601}");
    // The code point just below the surrogate block skips over it.
    expect(prefixUpperBound("퟿")).toBe("");
    // Nothing above the top of the range: the caller compiles the lower bound
    // alone rather than wrapping to something that sorts below the prefix.
    expect(prefixUpperBound("\u{10FFFF}")).toBeNull();
    expect(prefixUpperBound("a\u{10FFFF}")).toBe("b");
  });

  it("applies to text and timestamp columns only", () => {
    rejects({ where: JSON.stringify({ reps: { prefix: "1" } }) }, /prefix applies to a text/);
  });
});

describe("like", () => {
  it("accepts wildcards anywhere in the pattern", () => {
    for (const pattern of ["photo%", "%photo", "%pho%to%", "photo_", "plain"]) {
      const q = rows({ where: JSON.stringify({ id: { like: pattern } }) });
      expect(q.where.some((c) => c.predicate.op === "like")).toBe(true);
    }
  });

  it("needs no companion predicate", () => {
    // Unlike the `regex` operator it replaces. `LIKE` is pushed into the engine
    // and is linear in the subject, so an unanchored pattern costs what an `eq`
    // on an unindexed column costs and earns no special rule.
    const q = rows({ where: JSON.stringify({ id: { like: "%x%" } }) });
    expect(q.where).toHaveLength(1);
  });

  it("accepts the three meaningful escapes", () => {
    for (const pattern of ["100\\%", "a\\_b", "c\\\\d"]) {
      const q = rows({ where: JSON.stringify({ id: { like: pattern } }) });
      expect(q.where.some((c) => c.predicate.op === "like")).toBe(true);
    }
  });

  it("refuses an escape that means nothing", () => {
    // `\d` would quietly match a literal `d` on both engines, so an author who
    // wrote it meaning "a digit" gets an error rather than a wrong answer.
    rejects({ where: JSON.stringify({ id: { like: "\\d+" } }) }, /not a like escape/);
    rejects({ where: JSON.stringify({ id: { like: "a\\" } }) }, /lone/);
  });

  it("caps pattern length and refuses an empty one", () => {
    rejects({ where: JSON.stringify({ id: { like: "a".repeat(201) } }) }, /the maximum is 200/);
    rejects({ where: JSON.stringify({ id: { like: "" } }) }, /non-empty/);
  });

  it("applies to text and timestamp columns only", () => {
    rejects({ where: JSON.stringify({ reps: { like: "1%" } }) }, /like applies to a text/);
  });
});

describe("select, order and limit", () => {
  it("projects a column list and refuses an undeclared one", () => {
    expect(rows({ select: "id,due" }).select).toEqual(["id", "due"]);
    rejects({ select: "id,nope" }, /not a column/);
    rejects({ select: "deleted_at" }, /cannot be projected/);
  });

  it("allows the sync-internal columns in select and order", () => {
    expect(rows({ select: "id,updated_at,node_id" }).select).toContain("updated_at");
    expect(rows({ order: "updated_at.desc" }).order[0]).toMatchObject({ column: "updated_at" });
  });

  it("states a null position on every key, since the engines disagree", () => {
    expect(rows({ order: "due.desc" }).order[0]).toEqual({
      column: "due",
      direction: "desc",
      nulls: "last",
    });
    expect(rows({ order: "due.asc.nullsfirst" }).order[0]!.nulls).toBe("first");
  });

  it("appends the primary key so the ordering is total", () => {
    expect(rows({ order: "due.desc" }).order.map((t) => t.column)).toEqual(["due", "id"]);
    // Already named, so not appended twice.
    expect(rows({ order: "id.desc" }).order.map((t) => t.column)).toEqual(["id"]);
  });

  it("refuses ordering by a boolean column", () => {
    // The case a value-shaped guard never caught: `order` carries no value to
    // inspect, so before `boolean` left the orderable types this parsed and a
    // page token ended up keyed on a column with two possible values.
    rejects({ order: "suspended.asc" }, /has no ordering/);
  });

  it("refuses an unknown order modifier", () => {
    rejects({ order: "due.sideways" }, /not an order modifier/);
  });

  it("defaults and caps the limit", () => {
    expect(rows({}).limit).toBe(DEFAULT_LIMIT);
    expect(rows({ limit: "200" }).limit).toBe(200);
    rejects({ limit: String(MAX_LIMIT + 1) }, /at most 500/);
    rejects({ limit: "0" }, /at least 1/);
    rejects({ limit: "ten" }, /whole number/);
  });

  it("refuses an include the table has no relation for", () => {
    rejects({ include: "metadata" }, /not a relation of "card_state"/);
  });
});

describe("page_token", () => {
  it("round-trips under the ordering it was cut for", () => {
    const order = rows({ order: "due.desc" }).order;
    const token = encodePageToken({
      order: appOrderSignature(order),
      keys: [
        { isNull: false, value: TS },
        { isNull: false, value: "c1" },
      ],
    });
    const q = rows({ order: "due.desc", page_token: token });
    expect(q.pageToken?.keys).toHaveLength(2);
  });

  it("refuses a token cut under a different ordering rather than restarting", () => {
    const token = encodePageToken({
      order: appOrderSignature(rows({ order: "due.desc" }).order),
      keys: [
        { isNull: false, value: TS },
        { isNull: false, value: "c1" },
      ],
    });
    rejects({ order: "due.asc", page_token: token }, /cut under a different ordering/);
  });

  it("refuses a token this server did not issue", () => {
    rejects({ page_token: "not-a-token" }, /not a token this server issued/);
  });
});

describe("aggregate", () => {
  it("makes select the GROUP BY list", () => {
    const q = groups({
      select: "deck_id",
      aggregate: JSON.stringify({ due_count: { fn: "count" } }),
    });
    expect(q.groupBy).toEqual(["deck_id"]);
    expect(q.aggregates).toEqual([{ name: "due_count", fn: "count", col: null, distinct: false }]);
  });

  it("produces a global aggregate when select is empty", () => {
    expect(groups({ aggregate: JSON.stringify({ n: { fn: "count" } }) }).groupBy).toEqual([]);
  });

  it("carries all seven forms", () => {
    const q = groups({
      select: "deck_id",
      aggregate: JSON.stringify({
        row_count: { fn: "count" },
        value_count: { fn: "count", col: "due" },
        distinct_count: { fn: "count", distinct: "deck_id" },
        total: { fn: "sum", col: "reps" },
        mean: { fn: "avg", col: "strength" },
        lowest: { fn: "min", col: "due" },
        highest: { fn: "max", col: "due" },
      }),
    });
    expect(q.aggregates).toHaveLength(7);
    expect(q.aggregates.find((a) => a.name === "distinct_count")).toMatchObject({ distinct: true });
  });

  it("refuses min and max over a boolean column", () => {
    // Same rule as the comparison operators, reached through the aggregate
    // path. `count(distinct suspended)` stays legal — counting the two values
    // is a question; asking which is smaller is not.
    rejects(
      { aggregate: JSON.stringify({ lo: { fn: "min", col: "suspended" } }) },
      /needs an orderable column/,
    );
    expect(
      groups({ aggregate: JSON.stringify({ n: { fn: "count", distinct: "suspended" } }) })
        .aggregates,
    ).toEqual([{ name: "n", fn: "count", col: "suspended", distinct: true }]);
  });

  it("refuses sum and avg over a non-numeric column", () => {
    rejects(
      { aggregate: JSON.stringify({ t: { fn: "sum", col: "deck_id" } }) },
      /sum needs a numeric column/,
    );
    rejects(
      { aggregate: JSON.stringify({ t: { fn: "avg", col: "due" } }) },
      /avg needs a numeric column/,
    );
  });

  it("refuses an output name that collides with a column", () => {
    rejects(
      { aggregate: JSON.stringify({ due: { fn: "count" } }) },
      /collides with a column/,
    );
  });

  it("lets order name a grouping column or an aggregate output, and nothing else", () => {
    expect(
      groups({
        select: "deck_id",
        aggregate: JSON.stringify({ n: { fn: "count" } }),
        order: "n.desc",
      }).order[0],
    ).toMatchObject({ column: "n", direction: "desc" });
    rejects(
      { select: "deck_id", aggregate: JSON.stringify({ n: { fn: "count" } }), order: "reps.asc" },
      /grouping column or an aggregate output/,
    );
  });

  it("refuses page_token, because an aggregate result holds no rows", () => {
    rejects(
      { aggregate: JSON.stringify({ n: { fn: "count" } }), page_token: "x" },
      /addresses a row and an aggregate result holds none/,
    );
  });

  it("refuses distinct outside count", () => {
    rejects(
      { aggregate: JSON.stringify({ t: { fn: "sum", distinct: "reps" } }) },
      /distinct applies to count only/,
    );
  });
});

