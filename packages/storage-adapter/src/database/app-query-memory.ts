/**
 * The parsed query, evaluated over rows already in hand.
 *
 * What `app-query.ts` compiles to SQL, this evaluates in JavaScript, for the
 * in-memory adapter. It exists for the reason the mock's record `query` gives:
 * a mock that answers a question the real adapters answer differently is worse
 * than one that refuses to answer it, and the SDK and sync suites believe the
 * mock's word.
 *
 * The two paths share everything that can be shared — the predicate vocabulary,
 * the page cut, the token encoding — and the semantics that cannot be shared
 * are restated here against the same rules the compiler spells in SQL:
 *
 *   - `eq` against null means `IS NULL`, and `ne` keeps the null bucket.
 *   - Every order key carries its own null position, rather than inheriting a
 *     default from anywhere.
 *   - A keyset continuation is "strictly after the row this token names", read
 *     lexicographically down the ordering.
 *
 * It is not a query planner and does no index work: every call walks every row.
 * That is the right trade for an adapter whose whole store is a `Map`.
 */

import { LIKE_ESCAPE_CHAR } from "./app-query-types.js";
import type {
  AggregateQuery,
  AggregateTerm,
  OrderTerm,
  ParsedQuery,
  ParsedQueryResult,
  Predicate,
  QueryValue,
  RowQuery,
  WhereClause,
} from "./app-query-types.js";
import { collectAggregatePage, collectRowPage, orderKeyAlias } from "./app-query.js";

/** Run a parsed query over a table's rows. */
export async function runInMemoryQuery(
  rows: readonly Record<string, unknown>[],
  query: ParsedQuery,
  options: { readonly serverWhere?: readonly WhereClause[] } = {},
): Promise<ParsedQueryResult> {
  const matching = rows.filter(
    (row) => matches(row, options.serverWhere ?? []) && matches(row, query.where),
  );
  return query.mode === "aggregate"
    ? collectAggregatePage(query, aggregate(matching, query))
    : collectRowPage(query, page(matching, query));
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Does this row satisfy every clause?
 *
 * Exported because the mock's record `query` evaluates grammar predicates over
 * a column view of a `DataRecord`, and restating the null rules there is how
 * the mock would start answering `{"parent_id": null}` differently from the two
 * SQL adapters.
 */
export function matchesWhere(
  row: Record<string, unknown>,
  where: readonly WhereClause[],
): boolean {
  return matches(row, where);
}

function matches(row: Record<string, unknown>, where: readonly WhereClause[]): boolean {
  return where.every((clause) => holds(row[clause.column], clause.predicate));
}

function holds(raw: unknown, predicate: Predicate): boolean {
  const value = normalize(raw);
  switch (predicate.op) {
    case "eq":
    case "is":
      return predicate.value === null ? value === null : value === predicate.value;
    case "ne":
      // `col <> 'x'` excludes nulls in SQL, and a caller asking for "not x"
      // means every row that is not x — nulls included. The compiler adds the
      // null bucket back explicitly; so does this.
      return predicate.value === null ? value !== null : value === null || value !== predicate.value;
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (value === null) return false;
      const sign = compare(value, predicate.value);
      if (sign === null) return false;
      return { lt: sign < 0, lte: sign <= 0, gt: sign > 0, gte: sign >= 0 }[predicate.op];
    }
    case "in":
      return predicate.values.includes(value);
    case "prefix": {
      if (typeof value !== "string") return false;
      if (value < predicate.lower) return false;
      return predicate.upper === null || value < predicate.upper;
    }
    case "like":
      return typeof value === "string" && likeRegExp(predicate.pattern).test(value);
  }
}

/** SQLite hands a declared boolean back as 0/1; both engines agree after this. */
function normalize(value: unknown): QueryValue {
  if (value === undefined) return null;
  return value as QueryValue;
}

/** `null` when the two values are not of one comparable kind. */
function compare(a: QueryValue, b: QueryValue): number | null {
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return null;
}

/**
 * `LIKE` as a regular expression, with `%` and `_` as the wildcards and
 * backslash as the escape.
 *
 * Case-sensitive, which is what `PRAGMA case_sensitive_like = ON` makes SQLite
 * and what Postgres already is. The parser has already validated the pattern's
 * escape sequences, so an escape at the very end cannot reach here.
 */
function likeRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === LIKE_ESCAPE_CHAR && i + 1 < pattern.length) {
      out += escapeRegExp(pattern[i + 1]!);
      i += 1;
    } else if (ch === "%") out += "[\\s\\S]*";
    else if (ch === "_") out += "[\\s\\S]";
    else out += escapeRegExp(ch);
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The ordered, continued, projected page — one row past the limit, which is
 * what {@link collectRowPage} reads as "there is more".
 *
 * Every row carries the ordering values back under the same reserved aliases
 * the SQL compiler selects them under, so the page token is cut from the values
 * that were actually ordered on whatever the projection kept.
 */
function page(rows: readonly Record<string, unknown>[], query: RowQuery): Record<string, unknown>[] {
  const sorted = [...rows].sort((a, b) => {
    for (const term of query.order) {
      const decided = compareByTerm(normalize(a[term.column]), normalize(b[term.column]), term);
      if (decided !== 0) return decided;
    }
    return 0;
  });

  const after = query.pageToken;
  const continued = after
    ? sorted.filter((row) => isAfterToken(row, query.order, after.keys))
    : sorted;

  return continued.slice(0, query.limit + 1).map((row) => {
    const out: Record<string, unknown> = {};
    for (const name of query.select ?? Object.keys(row)) out[name] = normalize(row[name]);
    query.order.forEach((term, index) => {
      out[orderKeyAlias(index)] = normalize(row[term.column]);
    });
    return out;
  });
}

function compareByTerm(a: QueryValue, b: QueryValue, term: OrderTerm): number {
  if (a === null || b === null) {
    if (a === null && b === null) return 0;
    // The null position is the term's, never the engine's default.
    const nullFirst = term.nulls === "first" ? -1 : 1;
    return a === null ? nullFirst : -nullFirst;
  }
  const sign = compare(a, b) ?? 0;
  const normalized = sign < 0 ? -1 : sign > 0 ? 1 : 0;
  return term.direction === "desc" ? -normalized : normalized;
}

/**
 * "Strictly after the row this token names", read down the ordering.
 *
 * The same lexicographic chain the SQL side expands into `K1 after OR (K1 equal
 * AND K2 after) OR …`, which here is just the first key that differs deciding.
 */
function isAfterToken(
  row: Record<string, unknown>,
  order: readonly OrderTerm[],
  keys: readonly { readonly isNull: boolean; readonly value: QueryValue }[],
): boolean {
  for (let i = 0; i < order.length; i += 1) {
    const term = order[i]!;
    const key = keys[i]!;
    const decided = compareByTerm(
      normalize(row[term.column]),
      key.isNull ? null : key.value,
      term,
    );
    if (decided !== 0) return decided > 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

function aggregate(
  rows: readonly Record<string, unknown>[],
  query: AggregateQuery,
): Record<string, unknown>[] {
  // A grouped aggregate omits empty groups entirely, which falls out of
  // grouping the matching rows rather than enumerating the domain.
  const buckets = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = JSON.stringify(query.groupBy.map((c) => normalize(row[c])));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  // No `GROUP BY` at all is one global group, even over zero rows — which is
  // what makes `sum` and `avg` return null there rather than nothing.
  const groups = query.groupBy.length === 0 ? [rows as Record<string, unknown>[]] : [...buckets.values()];

  const out = groups.map((bucket) => {
    const group: Record<string, unknown> = {};
    for (const column of query.groupBy) group[column] = normalize(bucket[0]![column]);
    for (const term of query.aggregates) group[term.name] = applyAggregate(bucket, term);
    return group;
  });

  for (const term of [...query.order].reverse()) {
    out.sort((a, b) =>
      compareByTerm(normalize(a[term.column]), normalize(b[term.column]), {
        ...term,
        nulls: "last",
      }),
    );
  }
  return out;
}

function applyAggregate(
  rows: readonly Record<string, unknown>[],
  term: AggregateTerm,
): unknown {
  if (term.fn === "count") {
    // `count(*)` counts every matching row including all-null ones; `count(x)`
    // skips nulls, and the difference is the caller's to choose.
    if (term.col === null) return rows.length;
    const values = rows.map((r) => normalize(r[term.col!])).filter((v) => v !== null);
    return term.distinct ? new Set(values).size : values.length;
  }
  const values = rows.map((r) => normalize(r[term.col!])).filter((v) => v !== null);
  // Not coalesced to 0 over zero rows, deliberately: a coalesced result cannot
  // distinguish an empty match from a zero total.
  if (values.length === 0) return null;
  switch (term.fn) {
    case "sum":
      return values.reduce((total: number, v) => total + Number(v), 0);
    case "avg":
      return values.reduce((total: number, v) => total + Number(v), 0) / values.length;
    case "min":
      return values.reduce((lo, v) => ((compare(v, lo) ?? 0) < 0 ? v : lo));
    default:
      return values.reduce((hi, v) => ((compare(v, hi) ?? 0) > 0 ? v : hi));
  }
}
