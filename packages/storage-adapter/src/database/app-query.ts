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
import { LIKE_ESCAPE_CHAR, isWhereClause } from "./app-query-types.js";
import type {
  AggregateQuery,
  AggregateQueryResult,
  ColumnRef,
  JoinSpec,
  OrderTerm,
  Predicate,
  RowQuery,
  RowQueryResult,
  SoftDeletedScope,
  Subquery,
  WhereClause,
  WhereTerm,
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

    case "not_in":
      // The complement of `in`, so the null bucket comes back as it does for
      // `ne`: SQL's `NOT IN` alone drops the row where the column is null.
      return sql<boolean>`(${ref} is null or ${ref} not in (${sql.join(
        predicate.values.map((v) => sql`${v}`),
      )}))`;

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

/**
 * What compiling one query needs beyond the query itself.
 *
 * `base` is the alias the base table compiles under, or null when the query
 * names one table and its columns stay unqualified. A query with a join or a
 * subquery aliases the base table as its bare name, so every column reference
 * can be qualified and none is ambiguous.
 */
interface Compilation {
  readonly k: Kysely<AppQueryDb>;
  readonly base: string | null;
  readonly physicalName: ((table: string) => string) | undefined;
}

/** A parsed column reference as SQL: a bare name qualified by the base alias. */
function columnRef(c: Compilation, column: ColumnRef): RawBuilder<unknown> {
  return sql.ref(c.base === null || column.includes(".") ? column : `${c.base}.${column}`);
}

/** The physical table a join or subquery reads, aliased as its qualifier. */
function aliasedTable(c: Compilation, table: string, qualifier: string): string {
  if (!c.physicalName) {
    throw new Error(`a join or subquery needs BuildOptions.physicalName to name "${table}"`);
  }
  return `${c.physicalName(table)} as ${qualifier}`;
}

/** Does any term, at any depth, hold a subquery? */
function holdsSubquery(terms: readonly WhereTerm[]): boolean {
  return terms.some((t) => !isWhereClause(t) && t.kind !== "compare");
}

/**
 * One term as a boolean SQL expression.
 *
 * Literal clauses go through {@link predicateExpression}, the one place the
 * null rules live. A column operand follows the same rules: `eq` never matches
 * a null on either side, and `ne` is its exact complement.
 */
function termExpression(c: Compilation, term: WhereTerm): RawBuilder<boolean> {
  if (isWhereClause(term)) return predicateExpression(columnRef(c, term.column), term.predicate);

  switch (term.kind) {
    case "compare": {
      const a = columnRef(c, term.column);
      const b = columnRef(c, term.other);
      if (term.op === "ne") return sql<boolean>`(${a} is null or ${b} is null or ${a} <> ${b})`;
      const op = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[term.op];
      return sql<boolean>`${a} ${sql.raw(op)} ${b}`;
    }

    case "exists": {
      const sub = subquerySelect(c, term.sub, sql`1`);
      // Kysely parenthesizes an embedded select itself.
      return term.negated ? sql<boolean>`not exists ${sub}` : sql<boolean>`exists ${sub}`;
    }

    case "in_subquery": {
      const outer = columnRef(c, term.column);
      const sub = subquerySelect(c, term.sub, columnRef(c, term.sub.select));
      // The complement of `in`, as the literal `not_in` is. The parser requires
      // a NOT NULL select column, so the subquery never yields the null that
      // makes `NOT IN` unknown for every row.
      return term.negated
        ? sql<boolean>`(${outer} is null or ${outer} not in ${sub})`
        : sql<boolean>`${outer} in ${sub}`;
    }
  }
}

/**
 * `select <expr> from <table> as <qualifier> where …`, soft-delete included.
 *
 * Built as a Kysely select rather than as text, so the cloud's owner-scope
 * plugin finds the table and adds its own `user_id` predicate, as it does for
 * every nested select.
 */
function subquerySelect(c: Compilation, sub: Subquery, expr: RawBuilder<unknown>) {
  let qb = c.k.selectFrom(aliasedTable(c, sub.table, sub.qualifier) as never) as Qb;
  qb = qb.select(expr.as("v")) as Qb;
  qb = qb.where(sql<boolean>`${sql.ref(`${sub.qualifier}.deleted_at`)} is null` as never) as Qb;
  for (const term of sub.where) qb = qb.where(termExpression(c, term) as never) as Qb;
  return qb;
}

function applyWhere(c: Compilation, qb: Qb, where: readonly WhereTerm[]): Qb {
  let out = qb;
  for (const term of where) out = out.where(termExpression(c, term) as never) as Qb;
  return out;
}

/**
 * Each join, with the joined table's soft-delete filter inside its `on`.
 *
 * In `on` rather than in `where`, so a left join with no live match keeps the
 * base row and nulls the joined columns, as the caller asked.
 */
function applyJoins(c: Compilation, qb: Qb, joins: readonly JoinSpec[]): Qb {
  let out = qb;
  for (const join of joins) {
    const table = aliasedTable(c, join.table, join.qualifier);
    const on = sql.join(
      [
        sql<boolean>`${sql.ref(`${join.qualifier}.deleted_at`)} is null`,
        ...join.on.map((term) => termExpression(c, term)),
      ],
      sql` and `,
    );
    const expression = sql<boolean>`${on}`;
    out = (
      join.kind === "inner"
        ? out.innerJoin(table as never, (jb) => jb.on(expression as never))
        : out.leftJoin(table as never, (jb) => jb.on(expression as never))
    ) as Qb;
  }
  return out;
}

/** The compilation context for one query, aliased only when another table is in play. */
function compilationFor(
  k: Kysely<AppQueryDb>,
  query: RowQuery | AggregateQuery,
  options: BuildOptions,
): Compilation {
  const multi = query.joins.length > 0 || holdsSubquery(query.where);
  return { k, base: multi ? query.table : null, physicalName: options.physicalName };
}

/** `FROM <table>`, aliased as the base name when the query needs qualified names. */
function selectFromBase(c: Compilation, fullTableName: string): Qb {
  const from = c.base === null ? fullTableName : `${fullTableName} as ${c.base}`;
  return c.k.selectFrom(from as never) as Qb;
}

/**
 * `ORDER BY` with the null position spelled out.
 *
 * Emitted as a leading boolean rather than as `NULLS LAST`, which SQLite only
 * learned in 3.30 and which the two backends default differently on. The same
 * shape `record-queries.ts` already uses, for the same reason.
 */
function applyOrder(c: Compilation, qb: Qb, order: readonly OrderTerm[]): Qb {
  let out = qb;
  for (const term of order) {
    const ref = columnRef(c, term.column);
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
function applyPageToken(c: Compilation, qb: Qb, query: RowQuery): Qb {
  const token = query.pageToken;
  if (!token) return qb;
  const order = query.order;

  return qb.where((eb: ExpressionBuilder<AppQueryDb, string>) => {
    const after = (i: number) => {
      const term = order[i]!;
      const key = token.keys[i]!;
      const ref = columnRef(c, term.column);
      const op = term.direction === "desc" ? "<" : ">";
      if (key.isNull) {
        // The token sits in the null bucket. Whether anything is after it
        // depends on which end the nulls are at: with nulls last nothing is,
        // and with nulls first every non-null value is.
        return term.nulls === "first" ? sql<boolean>`${ref} is not null` : sql<boolean>`1 = 0`;
      }
      return term.nulls === "first"
        ? sql<boolean>`(${ref} is not null and ${ref} ${sql.raw(op)} ${key.value})`
        : sql<boolean>`(${ref} is null or ${ref} ${sql.raw(op)} ${key.value})`;
    };

    const equal = (i: number) => {
      const term = order[i]!;
      const key = token.keys[i]!;
      const ref = columnRef(c, term.column);
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
  /**
   * Which side of the tombstone the caller wants, for a table that has the
   * column.
   *
   * `exclude` is the default and the only reading any caller had before: live
   * rows. `only` is what a Trash view and a delete feed ask for, and `include`
   * is what a caller needs in order to tell "no such row" from "deliberately
   * deleted". Ignored when `excludeSoftDeleted` is false, because there is then
   * no column to filter on.
   */
  readonly softDeleted?: SoftDeletedScope;
  /**
   * The physical name of one of the app's tables, for joins and subqueries.
   *
   * Required only by a query that holds one; the shared plane never does.
   * `softDeleted` applies to the base table alone. A joined or subquery table
   * always excludes its deleted rows.
   */
  readonly physicalName?: (table: string) => string;
}

/** The soft-delete predicate, applied unless the table has no such column. */
function applySoftDelete(c: Compilation, qb: Qb, options: BuildOptions): Qb {
  // The server owns this predicate. A caller cannot name the column at all, so
  // this cannot be contradicted.
  if (options.excludeSoftDeleted === false) return qb;
  const scope = options.softDeleted ?? "exclude";
  if (scope === "include") return qb;
  if (scope === "only") {
    return qb.where(sql<boolean>`${columnRef(c, "deleted_at")} is not null` as never) as Qb;
  }
  return qb.where(sql<boolean>`${columnRef(c, "deleted_at")} is null` as never) as Qb;
}

/** One page of rows, plus the one extra row that reveals a further page. */
export function buildAppRowQuery(
  k: Kysely<AppQueryDb>,
  fullTableName: string,
  query: RowQuery,
  options: BuildOptions = {},
): CompiledQuery {
  const c = compilationFor(k, query, options);
  let qb = selectFromBase(c, fullTableName);
  qb = applyJoins(c, qb, query.joins);

  if (query.select === null) {
    // Every column of the base table. The parser requires `select` with a
    // join, so `*` never reaches a joined table.
    qb = (c.base === null ? qb.selectAll() : qb.selectAll(c.base as never)) as Qb;
  } else {
    // A base column comes back under its bare name and a joined column under
    // its qualified one, so `id` and `programs.id` never collide.
    qb = qb.select(query.select.map((col) => columnRef(c, col).as(col)) as never) as Qb;
  }
  // The ordering values ride back under reserved aliases so the page token is
  // cut from what the database ordered on, whatever the projection selected.
  query.order.forEach((term, index) => {
    qb = qb.select(columnRef(c, term.column).as(orderKeyAlias(index))) as Qb;
  });
  qb = applySoftDelete(c, qb, options);
  qb = applyWhere(c, qb, options.serverWhere ?? []);
  qb = applyWhere(c, qb, query.where);
  qb = applyPageToken(c, qb, query);
  qb = applyOrder(c, qb, query.order);
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
  const c = compilationFor(k, query, options);
  let qb = selectFromBase(c, fullTableName);
  qb = applyJoins(c, qb, query.joins);

  for (const column of query.groupBy) {
    qb = qb.select(columnRef(c, column).as(column)) as Qb;
  }
  for (const term of query.aggregates) {
    qb = qb.select(aggregateExpression(c, term, dialect).as(term.name)) as Qb;
  }

  qb = applySoftDelete(c, qb, options);
  qb = applyWhere(c, qb, options.serverWhere ?? []);
  qb = applyWhere(c, qb, query.where);

  for (const column of query.groupBy) {
    qb = qb.groupBy(columnRef(c, column)) as Qb;
  }
  // An aggregate output is ordered by its alias rather than by a repeat of the
  // expression: both engines resolve an output name in ORDER BY, and repeating
  // `count(*)` there would be a second expression free to disagree with the
  // first. A qualified group key's alias holds a dot, so it is quoted as one
  // identifier rather than split into table and column.
  for (const term of query.order) {
    const output = term.column.includes(".") ? sql.id(term.column) : sql.ref(term.column);
    qb = qb.orderBy(output, term.direction) as Qb;
  }
  // One row past the limit, which is what distinguishes a full page from a
  // complete result. Every predicate is now applied by the engine, so a fetched
  // row is a matching row rather than a candidate.
  qb = qb.limit(query.limit + 1) as Qb;

  return qb.compile();
}

function aggregateExpression(
  c: Compilation,
  term: { fn: string; col: string | null; distinct: boolean },
  dialect: AppQueryDialect,
) {
  if (term.fn === "count") {
    // `count(*)` counts every matching row including all-null ones and reads no
    // column; `count(x)` skips nulls. The difference is the caller's to choose
    // and is why both spellings exist in the grammar.
    if (term.col === null) return sql<number>`count(*)`;
    const ref = columnRef(c, term.col);
    return term.distinct ? sql<number>`count(distinct ${ref})` : sql<number>`count(${ref})`;
  }
  const ref = columnRef(c, term.col!);
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

/**
 * The declared column behind each key a query's rows come back under.
 *
 * Both appliers convert values by key: a `timestamp` or `bigint` on Postgres,
 * a `boolean` on SQLite. A joined column comes back under its qualified key, so
 * a map built from the base table's columns alone would leave it unconverted on
 * one engine. Aggregate inputs are included too, so `withAggregateOutputs` can
 * find the conversion a `min` over a joined column needs.
 *
 * `columnsOf` answers a table's declared columns by manifest name, or null
 * when the table is unknown.
 */
export function outputColumns<C extends { readonly name: string; readonly type: string }>(
  query: RowQuery | AggregateQuery,
  columnsOf: (table: string) => readonly C[] | null | undefined,
): Array<{ readonly name: string; readonly type: string }> | null {
  const base = columnsOf(query.table);
  if (!base) return null;
  const tables = new Map(query.joins.map((j) => [j.qualifier, j.table]));
  const lookup = (ref: ColumnRef) => {
    const dot = ref.indexOf(".");
    if (dot === -1) return base.find((col) => col.name === ref);
    const table = tables.get(ref.slice(0, dot));
    const name = ref.slice(dot + 1);
    return table === undefined ? undefined : columnsOf(table)?.find((col) => col.name === name);
  };

  const refs =
    query.mode === "rows"
      ? (query.select ?? base.map((col) => col.name))
      : [...query.groupBy, ...query.aggregates.flatMap((a) => (a.col === null ? [] : [a.col]))];
  const out: Array<{ readonly name: string; readonly type: string }> = [];
  for (const ref of new Set(refs)) {
    const column = lookup(ref);
    if (column) out.push({ name: ref, type: column.type });
  }
  return out;
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
