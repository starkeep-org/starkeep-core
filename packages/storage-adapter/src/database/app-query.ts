/**
 * The parsed query, compiled to SQL — once, for both engines.
 *
 * The same argument `record-queries.ts` makes. Two appliers held two
 * hand-written read grammars that had already drifted (a 50/500 limit in the
 * cloud, 100 and uncapped locally), and the whole point of a portable grammar
 * is that one query means one thing wherever it runs. Fixing that in two places
 * is how it comes back in one of them.
 *
 * What genuinely differs between the backends is carried by
 * {@link AppQueryDialect} and is small: `avg` returns `numeric` on Postgres and
 * a float on SQLite, so one of them casts.
 *
 * ## The one thing this module deliberately does not compile
 *
 * **The response budget.** A budget on *fetching* rather than on returning
 * belongs to whoever holds the cursor, so the caller iterates and stops. This
 * module only asks for one row more than the limit, so a full page is
 * distinguishable from a complete result.
 */

import type {
  CompiledQuery,
  ExpressionBuilder,
  Kysely,
  RawBuilder,
  SelectQueryBuilder,
} from "kysely";
import { sql } from "kysely";
import { LIKE_ESCAPE_CHAR } from "./app-query-types.js";
import type {
  AggregateQuery,
  AggregateQueryResult,
  OrderTerm,
  Predicate,
  RowQuery,
  RowQueryResult,
  WhereClause,
} from "./app-query-types.js";
import { encodePageToken, pageTokenFrom } from "./app-page-token.js";

/** The dynamic (schema-less) row type both adapters' compilers are built on. */
export type AppQueryDb = Record<string, Record<string, unknown>>;

type Qb = SelectQueryBuilder<AppQueryDb, string, unknown>;

/** What actually differs between the two backends. */
export interface AppQueryDialect {
  /**
   * Whether `avg` needs an explicit cast.
   *
   * DSQL returns `numeric` for `avg` over an integer column and `pg` hands that
   * over as a string; SQLite returns a float. Verified against the live cluster
   * on 2026-09-09 rather than assumed. Casting to `double precision` is what
   * makes both servers answer one JSON number type.
   */
  readonly castAvgToDouble: boolean;
}

export const SQLITE_APP_QUERY_DIALECT: AppQueryDialect = { castAvgToDouble: false };
export const POSTGRES_APP_QUERY_DIALECT: AppQueryDialect = { castAvgToDouble: true };

/**
 * The alias one ordering value rides back under.
 *
 * A page token is cut from the values the database actually ordered on, and a
 * projection may not have selected them — `select=id&order=due.desc` orders by
 * a column the caller never asked for. Selecting them under a reserved alias
 * means the token carries the ordered value rather than a second computation of
 * it that could disagree, and the alias is stripped before the row is returned.
 */
export function orderKeyAlias(index: number): string {
  return `__ok${index}`;
}

/** Is this key one of the reserved aliases the compiler adds? */
export function isOrderKeyAlias(key: string): boolean {
  return key.startsWith("__ok");
}

/**
 * One predicate, as a boolean SQL expression over a caller-supplied reference.
 *
 * Takes the reference rather than a column name because `record-queries.ts`
 * qualifies its columns whenever the capture-time joins are in play, and that
 * module compiles the same predicates this one does. Two copies of the null
 * rules below is exactly how the two planes would start answering the same
 * `{"parent_id": null}` differently.
 */
export function predicateExpression(
  ref: RawBuilder<unknown>,
  predicate: Predicate,
): RawBuilder<boolean> {
  switch (predicate.op) {
    case "eq":
      // `= NULL` is never true in SQL, so an equality against null is compiled
      // as `IS NULL` — which is what a caller writing `{"col": null}` means.
      return predicate.value === null
        ? sql<boolean>`${ref} is null`
        : sql<boolean>`${ref} = ${predicate.value}`;

    case "ne":
      // `<> NULL` is unknown for every row, so the negation of a null has to be
      // spelled `IS NOT NULL`. The other direction needs the null bucket added
      // back: `col <> 'x'` excludes nulls on both engines, and a caller asking
      // for "not x" means every row that is not x, nulls included.
      return predicate.value === null
        ? sql<boolean>`${ref} is not null`
        : sql<boolean>`(${ref} is null or ${ref} <> ${predicate.value})`;

    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const op = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[predicate.op];
      return sql<boolean>`${ref} ${sql.raw(op)} ${predicate.value}`;
    }

    case "in":
      return sql<boolean>`${ref} in (${sql.join(predicate.values.map((v) => sql`${v}`))})`;

    case "is":
      return predicate.value === null
        ? sql<boolean>`${ref} is null`
        : sql<boolean>`${ref} = ${predicate.value}`;

    case "prefix":
      // A half-open range, which is an index seek on both engines. `upper` is
      // null only when the prefix has no successor at all, in which case the
      // lower bound alone is the whole range.
      return predicate.upper === null
        ? sql<boolean>`${ref} >= ${predicate.lower}`
        : sql<boolean>`(${ref} >= ${predicate.lower} and ${ref} < ${predicate.upper})`;

    case "like":
      // The escape character is bound rather than written into the SQL text,
      // so neither engine's string-literal rules can reinterpret it. SQLite
      // matches Postgres here only because the local connection sets
      // `PRAGMA case_sensitive_like = ON` — see `bootstrap.ts`.
      return sql<boolean>`${ref} like ${predicate.pattern} escape ${LIKE_ESCAPE_CHAR}`;
  }
}

function applyPredicate(qb: Qb, column: string, predicate: Predicate): Qb {
  return qb.where(predicateExpression(sql.ref(column), predicate) as never) as Qb;
}

function applyWhere(qb: Qb, where: readonly WhereClause[]): Qb {
  let out = qb;
  for (const clause of where) out = applyPredicate(out, clause.column, clause.predicate);
  return out;
}

/**
 * `ORDER BY` with the null position spelled out.
 *
 * Emitted as a leading boolean rather than as `NULLS LAST`, which SQLite only
 * learned in 3.30 and which the two backends default differently on. The same
 * shape `record-queries.ts` already uses, for the same reason.
 */
function applyOrder(qb: Qb, order: readonly OrderTerm[]): Qb {
  let out = qb;
  for (const term of order) {
    const ref = sql.ref(term.column);
    out = out.orderBy(sql`(${ref} is null)`, term.nulls === "first" ? "desc" : "asc") as Qb;
    out = out.orderBy(ref, term.direction) as Qb;
  }
  return out;
}

/**
 * The keyset predicate: "strictly after the row this token names".
 *
 * The expanded lexicographic chain rather than a row-value comparison, because
 * the keys can run in different directions and a null inside a row-value
 * comparison evaluates to NULL — which returns an empty page instead of an
 * error, the quietest possible failure.
 *
 *   K1 after
 *   OR (K1 equal AND K2 after)
 *   OR (K1 equal AND K2 equal AND K3 after)
 */
function applyPageToken(qb: Qb, query: RowQuery): Qb {
  const token = query.pageToken;
  if (!token) return qb;
  const order = query.order;

  return qb.where((eb: ExpressionBuilder<AppQueryDb, string>) => {
    const after = (i: number) => {
      const term = order[i]!;
      const key = token.keys[i]!;
      const ref = sql.ref(term.column);
      const op = term.direction === "desc" ? "<" : ">";
      if (key.isNull) {
        // The token sits in the null bucket. Whether anything is after it
        // depends on which end the nulls are at: with nulls last nothing is,
        // and with nulls first every non-null value is.
        return term.nulls === "first"
          ? sql<boolean>`${ref} is not null`
          : sql<boolean>`1 = 0`;
      }
      return term.nulls === "first"
        ? sql<boolean>`(${ref} is not null and ${ref} ${sql.raw(op)} ${key.value})`
        : sql<boolean>`(${ref} is null or ${ref} ${sql.raw(op)} ${key.value})`;
    };

    const equal = (i: number) => {
      const term = order[i]!;
      const key = token.keys[i]!;
      const ref = sql.ref(term.column);
      return key.isNull
        ? sql<boolean>`${ref} is null`
        : sql<boolean>`(${ref} is not null and ${ref} = ${key.value})`;
    };

    const terms = [];
    for (let i = 0; i < order.length; i += 1) {
      const prefix = [];
      for (let j = 0; j < i; j += 1) prefix.push(equal(j));
      terms.push(prefix.length === 0 ? after(i) : eb.and([...prefix, after(i)]));
    }
    return eb.or(terms);
  }) as Qb;
}

export interface BuildOptions {
  /**
   * Predicates the server adds and a caller cannot express — the grant
   * predicate on the shared plane, and anything else the route owns.
   *
   * ANDed in beside the caller's own, so the grant rides *inside* the access
   * path rather than filtering what the access path returned. That property is
   * what the whole authorization question is about.
   */
  readonly serverWhere?: readonly WhereClause[];
  /**
   * Whether the table carries `deleted_at` and soft-deleted rows are excluded.
   *
   * Defaults to true, which is every app-syncable table, `shared.records` and
   * `shared.record_labels`. The per-category metadata tables are the exception:
   * a metadata row is derived state keyed by `record_id` and is deleted
   * outright when its record goes, so the column does not exist and a query
   * naming it fails at the engine rather than returning nothing.
   *
   * An option rather than a probe of the schema, because the caller that names
   * the table already knows which kind it is, and a compiler that guessed would
   * be able to guess wrong on a table it had never seen.
   */
  readonly excludeSoftDeleted?: boolean;
}

/** The soft-delete predicate, applied unless the table has no such column. */
function applySoftDelete(qb: Qb, options: BuildOptions): Qb {
  // The server owns this predicate. A caller cannot name the column at all, so
  // this cannot be contradicted.
  if (options.excludeSoftDeleted === false) return qb;
  return qb.where(sql<boolean>`${sql.ref("deleted_at")} is null` as never) as Qb;
}

/** One page of rows, plus the one extra row that reveals a further page. */
export function buildAppRowQuery(
  k: Kysely<AppQueryDb>,
  fullTableName: string,
  query: RowQuery,
  options: BuildOptions = {},
): CompiledQuery {
  let qb = k.selectFrom(fullTableName as never) as Qb;

  if (query.select === null) {
    qb = qb.selectAll() as Qb;
  } else {
    qb = qb.select(query.select.map((c) => sql.ref(c).as(c)) as never) as Qb;
  }
  // The ordering values ride back under reserved aliases so the page token is
  // cut from what the database ordered on, whatever the projection selected.
  query.order.forEach((term, index) => {
    qb = qb.select(sql.ref(term.column).as(orderKeyAlias(index))) as Qb;
  });
  qb = applySoftDelete(qb, options);
  qb = applyWhere(qb, options.serverWhere ?? []);
  qb = applyWhere(qb, query.where);
  qb = applyPageToken(qb, query);
  qb = applyOrder(qb, query.order);
  // One row past the limit, which is what distinguishes a full page from a
  // complete result. Every predicate is now applied by the engine, so a fetched
  // row is a matching row rather than a candidate.
  qb = qb.limit(query.limit + 1) as Qb;

  return qb.compile();
}

/** The aggregate form: `select` is the `GROUP BY` list. */
export function buildAppAggregateQuery(
  k: Kysely<AppQueryDb>,
  fullTableName: string,
  query: AggregateQuery,
  dialect: AppQueryDialect,
  options: BuildOptions = {},
): CompiledQuery {
  let qb = k.selectFrom(fullTableName as never) as Qb;

  for (const column of query.groupBy) {
    qb = qb.select(sql.ref(column).as(column)) as Qb;
  }
  for (const term of query.aggregates) {
    qb = qb.select(aggregateExpression(term, dialect).as(term.name)) as Qb;
  }

  qb = applySoftDelete(qb, options);
  qb = applyWhere(qb, options.serverWhere ?? []);
  qb = applyWhere(qb, query.where);

  for (const column of query.groupBy) {
    qb = qb.groupBy(sql.ref(column)) as Qb;
  }
  // An aggregate output is ordered by its alias rather than by a repeat of the
  // expression: both engines resolve an output name in ORDER BY, and repeating
  // `count(*)` there would be a second expression free to disagree with the
  // first.
  for (const term of query.order) {
    qb = qb.orderBy(
      sql.ref(term.column),
      term.direction,
    ) as Qb;
  }
  // One row past the limit, which is what distinguishes a full page from a
  // complete result. Every predicate is now applied by the engine, so a fetched
  // row is a matching row rather than a candidate.
  qb = qb.limit(query.limit + 1) as Qb;

  return qb.compile();
}

function aggregateExpression(
  term: { fn: string; col: string | null; distinct: boolean },
  dialect: AppQueryDialect,
) {
  if (term.fn === "count") {
    // `count(*)` counts every matching row including all-null ones and reads no
    // column; `count(x)` skips nulls. The difference is the caller's to choose
    // and is why both spellings exist in the grammar.
    if (term.col === null) return sql<number>`count(*)`;
    const ref = sql.ref(term.col);
    return term.distinct ? sql<number>`count(distinct ${ref})` : sql<number>`count(${ref})`;
  }
  const ref = sql.ref(term.col!);
  switch (term.fn) {
    case "sum":
      // Not coalesced to 0 over zero rows, deliberately: a coalesced result
      // cannot distinguish an empty match from a zero total.
      return sql<number | null>`sum(${ref})`;
    case "avg":
      return dialect.castAvgToDouble
        ? sql<number | null>`cast(avg(${ref}) as double precision)`
        : sql<number | null>`avg(${ref})`;
    case "min":
      return sql<unknown>`min(${ref})`;
    default:
      return sql<unknown>`max(${ref})`;
  }
}

/** Strip the reserved ordering aliases from a row before it goes on the wire. */
export function stripOrderKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!isOrderKeyAlias(key)) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Executing a compiled query
// ---------------------------------------------------------------------------

/**
 * The response budget, in bytes.
 *
 * A row limit cannot bound a response at all: DSQL allows a single `text` value
 * up to 1 MiB, so a handful of rows can exceed any payload ceiling, and
 * Lambda's 6 MB synchronous response limit fails hard and opaquely rather than
 * returning a short page. 4 MB leaves margin for the envelope and for base64 on
 * the API Gateway path, and turns that failure into a short page with a cursor.
 *
 * It is a rare-path guard rather than the primary bound. At realistic widths —
 * Memo's widest table is about 670 bytes per row — 500 rows is around 1 MB and
 * this never engages.
 *
 * It applies on both servers at the same threshold. The local server has no
 * payload ceiling and needs no protection, but a budget that engaged only in
 * the cloud would make one query return different results in the two
 * environments, which is the portability contract the grammar exists to keep.
 */
export const RESPONSE_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * Cut a page from a row stream, applying the row limit and the response budget.
 *
 * The budget is on **fetching** rather than on returning. An earlier draft had
 * serialization stop at 4 MB and throw away the tail, which wastes retrieval
 * work already paid for; here the caller supplies an iterator —
 * `better-sqlite3`'s `.iterate()`, a `pg` cursor — and this stops pulling from
 * it. Nothing retrieved is discarded.
 */
export async function collectRowPage(
  query: RowQuery,
  source: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
): Promise<RowQueryResult> {
  const kept: Record<string, unknown>[] = [];
  let lastRaw: Record<string, unknown> | null = null;
  let bytes = 0;
  let truncated = false;

  for await (const raw of source as AsyncIterable<Record<string, unknown>>) {
    if (kept.length === query.limit) {
      // One row past the limit exists, so rows were left behind.
      truncated = true;
      break;
    }

    const row = stripOrderKeys(raw);
    bytes += JSON.stringify(row).length;
    if (bytes > RESPONSE_BUDGET_BYTES && kept.length > 0) {
      // Stop before adding this row: a page that exceeded the budget would fail
      // at the transport, which is the opaque failure the budget exists to turn
      // into a short page. The first row is always kept, because a page of zero
      // rows with a cursor pointing at the row that did not fit is a caller
      // that can make no progress.
      truncated = true;
      break;
    }
    kept.push(row);
    lastRaw = raw;
  }

  return {
    mode: "rows",
    rows: kept,
    truncated,
    pageToken:
      truncated && lastRaw
        ? encodePageToken(pageTokenFrom(query.order, lastRaw, orderKeyAlias))
        : null,
  };
}

/** Cut an aggregate result, which is bounded by `limit` and carries no cursor. */
export function collectAggregatePage(
  query: AggregateQuery,
  groups: readonly Record<string, unknown>[],
): AggregateQueryResult {
  const truncated = groups.length > query.limit;
  return {
    mode: "aggregate",
    groups: truncated ? groups.slice(0, query.limit) : [...groups],
    truncated,
  };
}
