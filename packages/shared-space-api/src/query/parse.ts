/**
 * The one query parser, for both data planes.
 *
 * Input is a request's parameters; output is a {@link ParsedQuery}. No SQL, no
 * engine knowledge, no I/O — which is what makes every rule below testable
 * without a database, and what makes it possible for two servers to agree.
 *
 * ## The parameters
 *
 * `where` and `aggregate` carry strict JSON. `select`, `order`, `limit`,
 * `page_token` and `include` stay flat. Every top-level name is reserved by
 * construction, so no sigil distinguishes a parameter from a column — the `$`
 * prefix an earlier draft carried had nothing left to protect once the filters
 * moved under one key.
 *
 * `JSON.parse` is the whole parse. JavaScript object notation is rejected,
 * because parsing it means running `eval` on an app-supplied string.
 *
 * ## The rules, and where they come from
 *
 * Each of the checks below is a rejection path with a test behind it. Three
 * carry more weight than the rest, because they are the places SQLite and DSQL
 * would otherwise answer the same query differently:
 *
 *   - `select` **is** the `GROUP BY` list whenever `aggregate` is present, so
 *     `SELECT max(x), y` with no grouping is unrepresentable. SQLite accepts
 *     that shape and picks a row; Postgres rejects it with `42803`.
 *   - Every `order` key carries an explicit null position, because SQLite sorts
 *     nulls first and Postgres sorts them last.
 *   - Every value is checked against its column's declared type, because
 *     SQLite's dynamic typing accepts what Postgres refuses.
 */

import type { AppSyncableColumnInfo } from "@starkeep/sync-engine";
import { SOFT_DELETE_COLUMN, SYSTEM_COLUMN_NAMES } from "../app-syncable/columns.js";
import { decodePageToken } from "@starkeep/storage-adapter";
import { prefixUpperBound } from "./prefix.js";
import { validateLikePattern } from "./like.js";
import {
  QueryParseError,
  type AggregateFn,
  type AggregateQuery,
  type AggregateTerm,
  type OrderTerm,
  type ParsedQuery,
  type Predicate,
  type QueryParams,
  type QueryTableSchema,
  type QueryValue,
  type RowQuery,
  type WhereClause,
} from "./types.js";
import { checkValue, isNumericColumn, isOrderableColumn } from "./values.js";

/**
 * The page a caller gets by not asking.
 *
 * A list, a grid or a table rarely shows more than about thirty items before
 * the reader scrolls, so thirty is what a UI actually consumes. `truncated` and
 * `page_token` are what make a small default safe rather than surprising: a
 * short page can never be mistaken for a complete one.
 */
export const DEFAULT_LIMIT = 30;

/**
 * The largest page a caller may ask for.
 *
 * Generous on purpose — the maximum should not make it hard to get the data —
 * and it bounds *server work* (scan, materialize, serialize) rather than
 * guessing at a safe payload, because a row count cannot bound a response at
 * all: DSQL allows a single `text` value up to 1 MiB, so a handful of rows can
 * exceed any payload ceiling. The response budget in the appliers is what
 * catches that, as a rare-path guard rather than the primary bound.
 */
export const MAX_LIMIT = 500;

const COMPARISON_OPS = new Set(["lt", "lte", "gt", "gte"]);
const ALL_OPS = ["lt", "lte", "gt", "gte", "ne", "in", "is", "prefix", "like"] as const;
const AGGREGATE_FNS = new Set<AggregateFn>(["count", "sum", "avg", "min", "max"]);

/**
 * Columns a caller may name in `select` and `order` but never in `where`.
 *
 * `updated_at` is a serialized HLC and `node_id` is the author it names, so
 * ordering by sync time is a real question a UI asks. Filtering on them is
 * reasoning about a sync-internal clock, which is not a promise the platform
 * makes to apps and would break the moment the encoding changed.
 *
 * `deleted_at` is refused everywhere: the server owns the soft-delete
 * predicate, and a caller that could name the column could contradict it.
 */
const PROJECTION_ONLY_SYSTEM_COLUMNS = new Set(["updated_at", "node_id"]);

function parseJsonParam(name: string, raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new QueryParseError(
      `${name} must be JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new QueryParseError(`${name} must be a JSON object`);
  }
  return parsed;
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Look a column up, refusing anything the table does not declare. */
function columnOf(schema: QueryTableSchema, name: string): AppSyncableColumnInfo {
  const column = schema.columns.find((c) => c.name === name);
  if (!column) {
    throw new QueryParseError(`"${name}" is not a column of "${schema.name}"`);
  }
  return column;
}

// ---------------------------------------------------------------------------
// where
// ---------------------------------------------------------------------------

function parseWhere(schema: QueryTableSchema, raw: string | undefined): WhereClause[] {
  if (raw === undefined || raw.trim() === "") return [];
  const object = parseJsonParam("where", raw) as Record<string, unknown>;
  const clauses: WhereClause[] = [];

  for (const [name, spec] of Object.entries(object)) {
    if (name === SOFT_DELETE_COLUMN) {
      throw new QueryParseError(
        `"${SOFT_DELETE_COLUMN}" is owned by the server, which always excludes ` +
          `soft-deleted rows; it cannot appear in where`,
      );
    }
    if (PROJECTION_ONLY_SYSTEM_COLUMNS.has(name)) {
      throw new QueryParseError(
        `"${name}" is a sync-internal column and may appear in select and order only`,
      );
    }
    const column = columnOf(schema, name);

    // A scalar means equality. Position disambiguates, so no sigil is needed
    // inside the object and nothing has to be escaped out of a value.
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      clauses.push({ column: name, predicate: { op: "eq", value: value(column, spec) } });
      continue;
    }

    const entries = Object.entries(spec as Record<string, unknown>);
    if (entries.length === 0) {
      throw new QueryParseError(`where["${name}"] is an empty object and asks nothing`);
    }
    for (const [op, operand] of entries) {
      clauses.push({ column: name, predicate: predicateFor(column, op, operand) });
    }
  }

  for (const required of schema.requiredFilters ?? []) {
    if (!clauses.some((c) => c.column === required)) {
      throw new QueryParseError(
        `"${schema.name}" requires ${(schema.requiredFilters ?? [])
          .map((c) => `"${c}"`)
          .join(" and ")} in where; without them the query scans the whole table`,
      );
    }
  }

  return clauses;
}

function value(column: AppSyncableColumnInfo, raw: unknown): QueryValue {
  const checked = checkValue(column, raw);
  if (!checked.ok) throw new QueryParseError(checked.message);
  return checked.value;
}

function predicateFor(column: AppSyncableColumnInfo, op: string, operand: unknown): Predicate {
  if (!(ALL_OPS as readonly string[]).includes(op)) {
    throw new QueryParseError(
      `"${op}" is not an operator; supported operators are ${ALL_OPS.join(", ")}`,
    );
  }
  const name = column.name;

  if (COMPARISON_OPS.has(op)) {
    const info = column;
    if (!isOrderableColumn(info)) {
      throw new QueryParseError(`"${name}" is a ${info.type} and has no ordering`);
    }
    const bound = value(column, operand);
    if (bound === null) {
      throw new QueryParseError(
        `${op} against null is never true; use {"is": null} to test for absence`,
      );
    }
    if (typeof bound === "boolean") {
      throw new QueryParseError(`"${name}" is a boolean and has no ordering`);
    }
    return { op: op as "lt" | "lte" | "gt" | "gte", value: bound };
  }

  switch (op) {
    case "ne":
      return { op: "ne", value: value(column, operand) };

    case "in": {
      if (!Array.isArray(operand)) {
        throw new QueryParseError(`in takes a JSON array; "${name}" received something else`);
      }
      if (operand.length === 0) {
        throw new QueryParseError(`in with an empty list matches nothing; omit the predicate`);
      }
      if (operand.length > MAX_IN_LIST) {
        throw new QueryParseError(
          `in takes at most ${MAX_IN_LIST} values; "${name}" received ${operand.length}`,
        );
      }
      return { op: "in", values: operand.map((v) => value(column, v)) };
    }

    case "is": {
      // Covers null, true and false, which is what removes the value-less
      // operator case from the parser entirely — an earlier draft carried
      // `isnull` and `notnull` as operators taking no operand.
      if (operand !== null && typeof operand !== "boolean") {
        throw new QueryParseError(`is takes null, true or false`);
      }
      if (operand !== null) {
        if (column.type !== "boolean") {
          throw new QueryParseError(
            `is true/false applies to a boolean column; "${name}" is ${column.type}`,
          );
        }
      } else if (column.notNull) {
        throw new QueryParseError(`"${name}" is NOT NULL, so is null matches nothing`);
      }
      return { op: "is", value: operand };
    }

    case "prefix": {
      if (column.type !== "text" && column.type !== "timestamp") {
        throw new QueryParseError(
          `prefix applies to a text or timestamp column; "${name}" is ${column.type}`,
        );
      }
      if (typeof operand !== "string" || operand.length === 0) {
        throw new QueryParseError(`prefix takes a non-empty string`);
      }
      return { op: "prefix", lower: operand, upper: prefixUpperBound(operand) };
    }

    case "like": {
      if (column.type !== "text" && column.type !== "timestamp") {
        throw new QueryParseError(
          `like applies to a text or timestamp column; "${name}" is ${column.type}`,
        );
      }
      if (typeof operand !== "string") {
        throw new QueryParseError(`like takes a string pattern`);
      }
      return { op: "like", pattern: validateLikePattern(operand) };
    }

    default:
      throw new QueryParseError(`"${op}" is not an operator`);
  }
}

/**
 * The longest `in` list accepted.
 *
 * Every element is a bind parameter, and both engines have a parameter ceiling
 * that fails at the driver rather than in the grammar. Photos' fingerprint
 * lookup — the largest real caller — batches ids well under this.
 */
export const MAX_IN_LIST = 500;

// ---------------------------------------------------------------------------
// select, order, limit
// ---------------------------------------------------------------------------

function parseSelect(schema: QueryTableSchema, raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const names = splitList(raw);
  if (names.length === 0) return null;
  for (const name of names) {
    if (name === SOFT_DELETE_COLUMN) {
      throw new QueryParseError(
        `"${SOFT_DELETE_COLUMN}" is owned by the server and cannot be projected`,
      );
    }
    columnOf(schema, name);
  }
  return [...new Set(names)];
}

/**
 * Parse `order`, e.g. `due.asc,id.desc.nullsfirst`.
 *
 * The null position may be given explicitly and is otherwise derived: nulls
 * last, whichever direction the key runs. Derived rather than left to the
 * engine because the two engines derive it differently, and stated on every
 * term in the parsed value so nothing downstream has to remember the rule.
 */
function parseOrder(
  raw: string | undefined,
  resolve: (column: string) => void,
): OrderTerm[] {
  if (raw === undefined || raw.trim() === "") return [];
  return splitList(raw).map((term) => {
    const parts = term.split(".");
    const column = parts[0]!;
    if (column.length === 0) throw new QueryParseError(`order term "${term}" names no column`);
    resolve(column);

    let direction: "asc" | "desc" = "asc";
    let nulls: "first" | "last" | null = null;
    for (const modifier of parts.slice(1)) {
      if (modifier === "asc" || modifier === "desc") direction = modifier;
      else if (modifier === "nullsfirst") nulls = "first";
      else if (modifier === "nullslast") nulls = "last";
      else {
        throw new QueryParseError(
          `"${modifier}" is not an order modifier; use asc, desc, nullsfirst or nullslast`,
        );
      }
    }
    return { column, direction, nulls: nulls ?? "last" };
  });
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new QueryParseError(`limit must be a whole number of at least 1`);
  }
  if (parsed > MAX_LIMIT) {
    throw new QueryParseError(`limit must be at most ${MAX_LIMIT}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

function parseAggregate(schema: QueryTableSchema, raw: string): AggregateTerm[] {
  const object = parseJsonParam("aggregate", raw) as Record<string, unknown>;
  const entries = Object.entries(object);
  if (entries.length === 0) {
    throw new QueryParseError(`aggregate is an empty object and asks nothing`);
  }

  return entries.map(([name, spec]) => {
    // An output name colliding with a column name would make one key in the
    // result row mean two things, and which one won would be the engine's
    // choice rather than the grammar's.
    if ((schema.columns ?? []).some((c) => c.name === name)) {
      throw new QueryParseError(
        `aggregate output "${name}" collides with a column of "${schema.name}"`,
      );
    }
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      throw new QueryParseError(`aggregate["${name}"] must be an object naming a function`);
    }
    const { fn, col, distinct } = spec as { fn?: unknown; col?: unknown; distinct?: unknown };
    if (typeof fn !== "string" || !AGGREGATE_FNS.has(fn as AggregateFn)) {
      throw new QueryParseError(
        `aggregate["${name}"].fn must be one of ${[...AGGREGATE_FNS].join(", ")}`,
      );
    }

    if (fn === "count") {
      if (col !== undefined && distinct !== undefined) {
        throw new QueryParseError(
          `aggregate["${name}"] sets both col and distinct; count takes one or neither`,
        );
      }
      // `count(*)` counts every matching row including all-null ones, reads no
      // column, and can be answered from any covering index. `count(x)` skips
      // nulls, so the two differ on a nullable column and the difference is the
      // caller's to choose.
      if (col === undefined && distinct === undefined) {
        return { name, fn: "count" as const, col: null, distinct: false };
      }
      const target = (col ?? distinct) as unknown;
      if (typeof target !== "string") {
        throw new QueryParseError(`aggregate["${name}"] col/distinct must name a column`);
      }
      aggregateColumn(schema, name, target);
      return { name, fn: "count" as const, col: target, distinct: distinct !== undefined };
    }

    if (distinct !== undefined) {
      throw new QueryParseError(`distinct applies to count only, not to ${fn}`);
    }
    if (typeof col !== "string") {
      throw new QueryParseError(`aggregate["${name}"].col must name a column for ${fn}`);
    }
    const column = aggregateColumn(schema, name, col);
    if (fn === "sum" || fn === "avg") {
      if (!isNumericColumn(column)) {
        throw new QueryParseError(
          `${fn} needs a numeric column; "${col}" is ${column.type}`,
        );
      }
    } else if (!isOrderableColumn(column)) {
      throw new QueryParseError(`${fn} needs an orderable column; "${col}" is ${column.type}`);
    }
    return { name, fn: fn as AggregateFn, col, distinct: false };
  });
}

function aggregateColumn(
  schema: QueryTableSchema,
  outputName: string,
  column: string,
): AppSyncableColumnInfo {
  if (column === SOFT_DELETE_COLUMN) {
    throw new QueryParseError(
      `aggregate["${outputName}"] names "${SOFT_DELETE_COLUMN}", which the server owns`,
    );
  }
  return columnOf(schema, column);
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export function parseQuery(schema: QueryTableSchema, params: QueryParams): ParsedQuery {
  const where = parseWhere(schema, params.where);
  const limit = parseLimit(params.limit);

  if (params.aggregate !== undefined && params.aggregate.trim() !== "") {
    return parseAggregateQuery(schema, params, where, limit);
  }
  return parseRowQuery(schema, params, where, limit);
}

function parseRowQuery(
  schema: QueryTableSchema,
  params: QueryParams,
  where: WhereClause[],
  limit: number,
): RowQuery {
  const select = parseSelect(schema, params.select);
  const requested = parseOrder(params.order, (column) => {
    if (column === SOFT_DELETE_COLUMN) {
      throw new QueryParseError(`"${SOFT_DELETE_COLUMN}" is owned by the server`);
    }
    const resolved = columnOf(schema, column);
    if (!isOrderableColumn(resolved)) {
      throw new QueryParseError(`"${column}" is a ${resolved.type} and has no ordering`);
    }
  });

  // The primary key completes the ordering. A keyset cursor has to name exactly
  // one row and a sort key does not, so a page ordered by `due` alone would
  // lose or repeat rows that share a `due` across the page boundary.
  const order: OrderTerm[] = [...requested];
  for (const pk of schema.pkColumns) {
    if (!order.some((t) => t.column === pk)) {
      order.push({ column: pk, direction: "asc", nulls: "last" });
    }
  }
  if (order.length === 0) {
    throw new QueryParseError(
      `"${schema.name}" declares no primary key, so no total ordering exists and no page ` +
        `can be continued; name an order explicitly`,
    );
  }

  const pageToken =
    params.page_token !== undefined && params.page_token.trim() !== ""
      ? decodePageToken(params.page_token, order)
      : null;

  const include = params.include === undefined ? [] : splitList(params.include);
  for (const edge of include) {
    if (!(schema.includable ?? []).includes(edge)) {
      throw new QueryParseError(
        `"${edge}" is not a relation of "${schema.name}"` +
          ((schema.includable ?? []).length > 0
            ? `; available: ${(schema.includable ?? []).join(", ")}`
            : ""),
      );
    }
  }

  return { mode: "rows", table: schema.name, select, where, order, limit, pageToken, include };
}

function parseAggregateQuery(
  schema: QueryTableSchema,
  params: QueryParams,
  where: WhereClause[],
  limit: number,
): AggregateQuery {
  // A keyset continuation addresses a row, and an aggregate result holds none.
  if (params.page_token !== undefined && params.page_token.trim() !== "") {
    throw new QueryParseError(
      `page_token addresses a row and an aggregate result holds none; ` +
        `aggregate queries are bounded by limit and report truncated`,
    );
  }
  if (params.include !== undefined && params.include.trim() !== "") {
    throw new QueryParseError(`include hydrates rows and an aggregate result holds none`);
  }

  const aggregates = parseAggregate(schema, params.aggregate!);
  // `select` is the GROUP BY list. SQL requires every non-aggregate output
  // column to appear in it, so the two lists are one list — which also makes
  // `SELECT max(x), y` unrepresentable rather than differently-answered.
  const groupBy = parseSelect(schema, params.select) ?? [];
  const outputs = new Set([...groupBy, ...aggregates.map((a) => a.name)]);

  const order = parseOrder(params.order, (column) => {
    if (!outputs.has(column)) {
      throw new QueryParseError(
        `order may name a grouping column or an aggregate output; "${column}" is neither`,
      );
    }
  });

  return { mode: "aggregate", table: schema.name, groupBy, aggregates, where, order, limit };
}
