/**
 * The typed query value both data servers compile, and the only thing either
 * of them accepts from an app.
 *
 * ## Why a grammar rather than SQL
 *
 * The platform runs SQLite locally and Aurora DSQL in the cloud, and the two
 * disagree by default about where nulls sort, about what `avg` over an integer
 * column returns, about whether `LIKE 'x%'` is case-sensitive, and about
 * whether a bare column may appear beside an aggregate. Handing an app SQL is
 * not an authorization problem on the app-syncable plane — the app owns its
 * whole namespace and there is nothing to confine — but SQL does not *mean the
 * same thing* on the two backends and carries no cost bound.
 *
 * This union is the portable, boundable subset: the questions the platform can
 * promise identical answers to on both engines, verified once by the
 * conformance suite rather than discovered per app, in production, on one
 * backend.
 *
 * ## Why one union for both planes
 *
 * Records, labels and per-category metadata all carry the caller's grant
 * discriminant as a column — `type` on `shared.records`, `record_type` on
 * `shared.record_labels` and (after this work) on the metadata tables — so the
 * server's grant predicate can be ANDed into the same parsed value rather than
 * applied to whatever a scan returned. That makes one parser, one operator set,
 * one cursor convention and one conformance suite serve every surface. Two
 * parsers would mean the shared plane drifting from the app plane again, which
 * is the failure this design exists to prevent.
 */

import type { LogicalColumnType } from "@starkeep/protocol-primitives";

/**
 * One column, as whoever describes the table describes it.
 *
 * Lives here rather than in `sync-engine` — which is where the app-syncable
 * namespace registry's `AppSyncableColumnInfo` is named — because the parser in
 * `shared-space-api` and the compilers in the two storage packages all need it,
 * and `sync-engine` sits above `storage-adapter` rather than below it.
 * `AppSyncableColumnInfo` is an alias of this.
 */
export interface AppColumnInfo {
  readonly name: string;
  readonly type: LogicalColumnType;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
}

/** A scalar an app can express in JSON and a column can hold. */
export type QueryValue = string | number | boolean | null;

/**
 * One predicate on one column. Every form carries its values already checked
 * against the column's declared type, so a compiler binds them without looking
 * at the schema again.
 */
export type Predicate =
  | { readonly op: "eq"; readonly value: QueryValue }
  | { readonly op: "ne"; readonly value: QueryValue }
  | { readonly op: "lt" | "lte" | "gt" | "gte"; readonly value: string | number }
  | { readonly op: "in"; readonly values: readonly QueryValue[] }
  /** `is` covers null, true and false — the whole value-less-operator case. */
  | { readonly op: "is"; readonly value: null | boolean }
  /**
   * A half-open range, not a pattern match.
   *
   * `prefix` compiles to `col >= lower AND col < upper`, which is an index seek
   * on both engines *unconditionally*: DSQL uses the `C` collation only and
   * SQLite defaults to `BINARY`, so byte order agrees. It takes a literal, so
   * `%` and `_` in app data carry no meaning and nothing needs escaping.
   *
   * `like` answers the anchored case too and reaches an index there, but only
   * because both engines' preconditions happen to hold. Prefer `prefix` when
   * the question really is "starts with".
   *
   * `upper` is null when the prefix has no successor (every trailing code unit
   * is at the top of its range), which compiles to the lower bound alone.
   */
  | { readonly op: "prefix"; readonly lower: string; readonly upper: string | null }
  /**
   * SQL `LIKE`, with `%` and `_` as the wildcards and a backslash escape.
   *
   * Pushed into the engine, unlike the `regex` operator this replaces. `LIKE`
   * is linear in the pattern and the subject on both engines, so there is no
   * pathological pattern to cap and no reason to evaluate it in the server:
   * the database filters, and only matching rows cross the wire.
   *
   * The pattern's escape sequences are validated by the parser, and the local
   * connection sets `PRAGMA case_sensitive_like = ON` so SQLite's ASCII
   * case-folding does not make the same pattern mean two things. See
   * `like.ts`.
   */
  | { readonly op: "like"; readonly pattern: string };

/**
 * The character that makes the next `%` or `_` in a `like` pattern a literal.
 *
 * Declared beside the predicate rather than beside the parser because the SQL
 * compiler binds it and the parser validates against it, and the two must not
 * be able to drift apart.
 */
export const LIKE_ESCAPE_CHAR = "\\";

/** One `WHERE` term: a column and a predicate over it, ANDed with the rest. */
export interface WhereClause {
  readonly column: string;
  readonly predicate: Predicate;
}

/**
 * One `ORDER BY` key.
 *
 * `nulls` is always explicit, never defaulted, because SQLite sorts nulls first
 * and Postgres sorts them last. A cursor cut under one convention and honoured
 * under the other skips or repeats a page, silently.
 */
export interface OrderTerm {
  readonly column: string;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

/**
 * One output column of an aggregate query.
 *
 * `col` is null only for `count(*)`. `distinct` is only ever set with `count`.
 */
export interface AggregateTerm {
  /** The output name, taken from the `aggregate` object's key. */
  readonly name: string;
  readonly fn: AggregateFn;
  readonly col: string | null;
  readonly distinct: boolean;
}

/**
 * A keyset continuation.
 *
 * Opaque to callers by contract: the encoded form is base64url JSON and apps
 * must not parse it, because its shape is the server's to change. `order` is a
 * signature of the ordering the token was cut under, so a token replayed
 * against a different `order` is rejected rather than honoured — a token that
 * silently restarts pagination duplicates rows, and a token honoured under the
 * wrong ordering skips them.
 */
export interface PageToken {
  readonly order: string;
  readonly keys: readonly { readonly isNull: boolean; readonly value: QueryValue }[];
}

/** A query that returns rows. */
export interface RowQuery {
  readonly mode: "rows";
  /** Bare table name. The endpoint path names it; `resolveTable` scopes it. */
  readonly table: string;
  /** Columns to project, or null for every column. */
  readonly select: readonly string[] | null;
  readonly where: readonly WhereClause[];
  /**
   * The full ordering, tiebreaker included.
   *
   * The parser appends the table's primary-key columns to whatever the caller
   * asked for, because a keyset cursor has to name exactly one row and a sort
   * key does not. A caller ordering by `due` alone gets `due, id` and can page
   * through ties without losing or repeating them.
   */
  readonly order: readonly OrderTerm[];
  readonly limit: number;
  readonly pageToken: PageToken | null;
  /**
   * Platform edges to hydrate after the page is cut. Shared plane only; app
   * tables carry no platform edges, so this is always empty there.
   */
  readonly include: readonly string[];
}

/** A query that returns aggregate groups. */
export interface AggregateQuery {
  readonly mode: "aggregate";
  readonly table: string;
  /**
   * The `GROUP BY` list, which is exactly the caller's `select`.
   *
   * SQL requires every non-aggregate output column to appear in `GROUP BY`, so
   * the two lists are one list. Empty means a global aggregate over one row.
   * The rule also forbids `SELECT max(x), y` with no `GROUP BY` — the one shape
   * SQLite accepts (picking an arbitrary row's `y`) and Postgres rejects with
   * `42803`, and therefore the one place the two engines would otherwise return
   * different answers to the same query.
   */
  readonly groupBy: readonly string[];
  readonly aggregates: readonly AggregateTerm[];
  readonly where: readonly WhereClause[];
  /** May name a grouping column or an aggregate output name, and nothing else. */
  readonly order: readonly OrderTerm[];
  readonly limit: number;
}

export type ParsedQuery = RowQuery | AggregateQuery;

/** What one row-query page returned. */
export interface RowQueryResult {
  readonly mode: "rows";
  readonly rows: readonly Record<string, unknown>[];
  /**
   * Rows were left behind — by the row limit, by the response budget, or by the
   * regex scan cap. A short page is never a complete one without this being
   * false, which is what makes a small default limit safe rather than
   * surprising.
   */
  readonly truncated: boolean;
  readonly pageToken: string | null;
}

/** What one aggregate query returned. */
export interface AggregateQueryResult {
  readonly mode: "aggregate";
  readonly groups: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

/**
 * Named `ParsedQueryResult` rather than `QueryResult` because
 * `@starkeep/storage-adapter` already exports a `QueryResult` for the shared
 * record path, and a file importing both would have to alias one of them.
 */
export type ParsedQueryResult = RowQueryResult | AggregateQueryResult;

/**
 * What the parser needs to know about the table being queried.
 *
 * Deliberately not the namespace entry itself: the shared plane has no
 * namespace registry, and records, labels and metadata each describe
 * themselves. One shape means one parser.
 */
export interface QueryTableSchema {
  readonly name: string;
  /**
   * The table's columns.
   *
   * Always present. An app-syncable table's columns come from its namespace
   * registry row, which both installers write from the manifest through one
   * helper; the shared plane's tables describe themselves in code. A registry
   * row carrying no columns is an install that did not finish, and the
   * namespace stores refuse to load one rather than letting a second, weaker
   * grammar exist for it.
   */
  readonly columns: readonly AppColumnInfo[];
  /** Ordered, and the tiebreaker the parser appends to every row query. */
  readonly pkColumns: readonly string[];
  /**
   * Columns a caller must constrain in `where`, if any.
   *
   * `shared.record_labels` requires `app_id` and `key`: the reverse index is
   * `(app_id, key, deleted_at, value, record_id)`, so a query without them
   * scans every app's assertions about every record rather than seeking. This
   * is a cost ceiling expressed as a query precondition, which is the only
   * place it can be expressed cheaply.
   */
  readonly requiredFilters?: readonly string[];
  /**
   * Columns a caller may project and order but never filter.
   *
   * The parser refuses `updated_at` and `node_id` in `where` on every table,
   * because filtering on a sync-internal clock is not a promise the platform
   * makes. The shared tables extend that list by one: `created_at` is a
   * serialized HLC there too, while on an app-syncable table it is an ordinary
   * app-owned column with app-chosen meaning. One rule, stated per table rather
   * than hard-coded for both planes.
   */
  readonly projectionOnly?: readonly string[];
  /** Edge names `include` may carry. Empty on the app-syncable plane. */
  readonly includable?: readonly string[];
}

/** Raw request parameters, before parsing. */
export interface QueryParams {
  readonly where?: string;
  readonly select?: string;
  readonly aggregate?: string;
  readonly order?: string;
  readonly limit?: string;
  readonly page_token?: string;
  readonly include?: string;
}

/** A rejection carrying the message the caller sees. Never a stack trace. */
export class QueryParseError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "QueryParseError";
  }
}
