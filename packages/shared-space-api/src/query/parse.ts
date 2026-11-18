/**
 * The one query parser, for both data planes.
 *
 * Input is a request's parameters; output is a {@link ParsedQuery}. No SQL, no
 * engine knowledge, no I/O — which is what makes every rule below testable
 * without a database, and what makes it possible for two servers to agree.
 *
 * ## The parameters
 *
 * `where`, `aggregate` and `join` carry strict JSON. `select`, `order`,
 * `limit`, `page_token` and `include` stay flat. Every top-level name is
 * reserved by construction, so no sigil distinguishes a parameter from a
 * column — the `$` prefix an earlier draft carried had nothing left to protect
 * once the filters moved under one key.
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
 *
 * ## More than one table
 *
 * On the app-syncable plane a query may join the app's other tables and test
 * them through `exists`, `not_exists` and `in`/`not_in` subqueries. The route
 * hands the parser an {@link AppTables} for that; the shared plane passes none,
 * and every multi-table form is then refused. Names follow one rule: a bare
 * name is a column of the base table, and `<qualifier>.<column>` names any
 * table in scope. Inside a join's `on` and inside a subquery every name carries
 * its qualifier, because more than one table is always in scope there.
 */

import type { AppSyncableColumnInfo } from "@starkeep/sync-engine";
import { SOFT_DELETE_COLUMN } from "../app-syncable/columns.js";
import { decodePageToken } from "@starkeep/storage-adapter";
import { prefixUpperBound } from "./prefix.js";
import { validateLikePattern } from "./like.js";
import {
  QueryParseError,
  isWhereClause,
  type AggregateFn,
  type AggregateQuery,
  type AggregateTerm,
  type ColumnRef,
  type CompareOp,
  type JoinSpec,
  type OrderTerm,
  type ParsedQuery,
  type Predicate,
  type QueryParams,
  type QueryTableSchema,
  type QueryValue,
  type RowQuery,
  type Subquery,
  type WhereTerm,
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

/**
 * How deeply subqueries may nest.
 *
 * A guard on the parser's recursion against a pathological request, not a cost
 * limit. "Days with a session that has a set" takes two levels.
 */
export const MAX_SUBQUERY_DEPTH = 4;

const COMPARISON_OPS = new Set(["lt", "lte", "gt", "gte"]);
const COLUMN_OPERAND_OPS = new Set<string>(["eq", "ne", "lt", "lte", "gt", "gte"]);
const ALL_OPS = [
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "not_in",
  "is",
  "prefix",
  "like",
] as const;
const AGGREGATE_FNS = new Set<AggregateFn>(["count", "sum", "avg", "min", "max"]);
const EXISTS_KEYS = new Set(["exists", "not_exists"]);
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

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

/**
 * The calling app's other tables, for joins and subqueries.
 *
 * The app-syncable route builds this from the app's namespace, so a reserved
 * or undeclared table stays unreachable through a join exactly as it is
 * through the path. The shared plane passes none.
 */
export interface AppTables {
  /** Every table the app may query, which is also every name an `as` must avoid. */
  readonly names: readonly string[];
  /** The table's description. Throws a {@link QueryParseError} for a name the app cannot query. */
  schemaOf(name: string): QueryTableSchema;
}

export interface ParseOptions {
  readonly tables?: AppTables;
}

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if ((schema.orderOnly ?? []).some((c) => c.name === name)) {
      throw new QueryParseError(
        `"${name}" is not a column of "${schema.name}" and may appear in order only`,
      );
    }
    throw new QueryParseError(`"${name}" is not a column of "${schema.name}"`);
  }
  return column;
}

/**
 * Look an *ordering* key up, which is the one position `orderOnly` answers.
 *
 * `captured_at` is not a column of `shared.records`, and a query ordered by it
 * is a join the records compiler builds rather than a column it reads.
 */
function orderColumnOf(schema: QueryTableSchema, name: string): AppSyncableColumnInfo {
  const declared = (schema.orderOnly ?? []).find((c) => c.name === name);
  return declared ?? columnOf(schema, name);
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** One table a name may refer to, under the qualifier the query gave it. */
interface ScopeEntry {
  readonly qualifier: string;
  readonly schema: QueryTableSchema;
}

/** A column a name resolved to. */
interface Resolved {
  /** Bare for the base table, `<qualifier>.<column>` otherwise. */
  readonly ref: ColumnRef;
  readonly qualifier: string;
  readonly name: string;
  readonly column: AppSyncableColumnInfo;
}

/**
 * The tables a name may refer to at one position in the query.
 *
 * Immutable: a join or a subquery extends the scope it was parsed in, and the
 * extension never leaks back out. The base table is always the first entry,
 * under its own name.
 */
class Scope {
  private constructor(
    readonly base: QueryTableSchema,
    private readonly entries: readonly ScopeEntry[],
    readonly tables: AppTables | undefined,
  ) {}

  static of(base: QueryTableSchema, tables: AppTables | undefined): Scope {
    return new Scope(base, [{ qualifier: base.name, schema: base }], tables);
  }

  with(entry: ScopeEntry): Scope {
    return new Scope(this.base, [...this.entries, entry], this.tables);
  }

  has(qualifier: string): boolean {
    return this.entries.some((e) => e.qualifier === qualifier);
  }

  qualifiers(): string[] {
    return this.entries.map((e) => e.qualifier);
  }

  /** The tables a multi-table form needs, or a refusal naming the form. */
  requireTables(form: string): AppTables {
    if (!this.tables) {
      throw new QueryParseError(`${form} applies to app tables only`);
    }
    return this.tables;
  }

  /**
   * Resolve a name to a column.
   *
   * `qualifiedOnly` holds inside a join's `on` and inside a subquery, where a
   * bare name could mean more than one table.
   */
  resolve(name: string, qualifiedOnly: boolean): Resolved {
    const dot = name.indexOf(".");
    if (dot === -1) {
      if (qualifiedOnly) {
        throw new QueryParseError(
          `"${name}" needs its table: inside on and inside a subquery, name every column ` +
            `as <table>.<column>, such as "${this.base.name}.${name}"`,
        );
      }
      return { ref: name, qualifier: this.base.name, name, column: columnOf(this.base, name) };
    }
    const qualifier = name.slice(0, dot);
    const columnName = name.slice(dot + 1);
    if (columnName.includes(".") || qualifier === "" || columnName === "") {
      throw new QueryParseError(`"${name}" is not a column name; use <table>.<column>`);
    }
    // The base table is the one table the shared plane holds, and naming it
    // qualified is harmless; naming anything else is a multi-table form.
    const entry = this.entries.find((e) => e.qualifier === qualifier);
    if (!entry) {
      this.requireTables(`the qualified name "${name}"`);
      throw new QueryParseError(
        `"${qualifier}" is not a table in scope here; in scope: ${this.qualifiers().join(", ")}`,
      );
    }
    const column = columnOf(entry.schema, columnName);
    const isBase = entry === this.entries[0];
    return { ref: isBase ? columnName : name, qualifier, name: columnName, column };
  }
}

/** The qualifier a parsed reference names. */
function qualifierOfRef(ref: ColumnRef, base: string): string {
  const dot = ref.indexOf(".");
  return dot === -1 ? base : ref.slice(0, dot);
}

/**
 * The qualifier a new join or subquery table takes.
 *
 * A table already in scope needs an `as`, or two tables would answer to one
 * name. An `as` must not equal any of the app's table names either, so that a
 * qualifier always reads as what it is.
 */
function qualifierFor(table: string, as: unknown, scope: Scope, tables: AppTables): string {
  if (as === undefined) {
    if (scope.has(table)) {
      throw new QueryParseError(
        `"${table}" is already in scope here; give the second use an "as", such as ` +
          `{"table":"${table}","as":"other_${table}"}`,
      );
    }
    return table;
  }
  if (typeof as !== "string" || !IDENT_RE.test(as)) {
    throw new QueryParseError(`"as" must be a name of lowercase letters, digits and underscores`);
  }
  if (tables.names.includes(as)) {
    throw new QueryParseError(`"as" must not be a table name; "${as}" names a table of this app`);
  }
  if (scope.has(as)) {
    throw new QueryParseError(`"${as}" is already in scope here; choose another "as"`);
  }
  return as;
}

function refuseUnknownFields(
  object: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new QueryParseError(`${what} takes ${allowed.join(", ")}; "${key}" is not one of them`);
    }
  }
}

// ---------------------------------------------------------------------------
// Predicates: where, on, and a subquery's where
// ---------------------------------------------------------------------------

interface PredicateContext {
  readonly qualifiedOnly: boolean;
  /** How many subqueries enclose this predicate object. */
  readonly depth: number;
}

/** Resolve a name in a filtering position, where the server-owned columns are refused. */
function filterColumn(scope: Scope, name: string, qualifiedOnly: boolean): Resolved {
  const resolved = scope.resolve(name, qualifiedOnly);
  const owner = resolved.qualifier === scope.base.name ? scope.base : null;
  if (resolved.name === SOFT_DELETE_COLUMN) {
    throw new QueryParseError(
      `"${SOFT_DELETE_COLUMN}" is owned by the server, which always excludes ` +
        `soft-deleted rows; it cannot appear in where`,
    );
  }
  if (
    PROJECTION_ONLY_SYSTEM_COLUMNS.has(resolved.name) ||
    (owner?.projectionOnly ?? []).includes(resolved.name)
  ) {
    throw new QueryParseError(
      `"${resolved.name}" is a sync-internal column and may appear in select and order only`,
    );
  }
  return resolved;
}

/**
 * Parse one predicate object into terms.
 *
 * The same function reads the top-level `where`, each join's `on` and each
 * subquery's `where`, so the three cannot come to mean different things.
 */
function parsePredicates(
  object: Record<string, unknown>,
  scope: Scope,
  context: PredicateContext,
): WhereTerm[] {
  const terms: WhereTerm[] = [];

  for (const [name, spec] of Object.entries(object)) {
    if (EXISTS_KEYS.has(name)) {
      terms.push(...parseExists(name === "not_exists", spec, scope, context));
      continue;
    }

    const resolved = filterColumn(scope, name, context.qualifiedOnly);

    // A scalar means equality. Position disambiguates, so no sigil is needed
    // inside the object and nothing has to be escaped out of a value.
    if (!isPlainObject(spec)) {
      terms.push({
        column: resolved.ref,
        predicate: { op: "eq", value: value(resolved.column, spec) },
      });
      continue;
    }

    const entries = Object.entries(spec);
    if (entries.length === 0) {
      throw new QueryParseError(`where["${name}"] is an empty object and asks nothing`);
    }
    for (const [op, operand] of entries) {
      if (op === "col") {
        throw new QueryParseError(
          `{"col": …} is a column operand and needs an operator, such as ` +
            `{"${name}": {"eq": {"col": ${JSON.stringify(operand)}}}}`,
        );
      }
      if (COLUMN_OPERAND_OPS.has(op) && isPlainObject(operand) && "col" in operand) {
        terms.push(compareTerm(scope, resolved, op as CompareOp, operand, context));
        continue;
      }
      if ((op === "in" || op === "not_in") && isPlainObject(operand)) {
        terms.push(inSubqueryTerm(scope, resolved, op === "not_in", operand, context));
        continue;
      }
      terms.push({ column: resolved.ref, predicate: predicateFor(resolved.column, op, operand) });
    }
  }

  return terms;
}

/** `{"a": {"eq": {"col": "b"}}}`: one column against another. */
function compareTerm(
  scope: Scope,
  left: Resolved,
  op: CompareOp,
  operand: Record<string, unknown>,
  context: PredicateContext,
): WhereTerm {
  refuseUnknownFields(operand, ["col"], "a column operand");
  if (typeof operand["col"] !== "string") {
    throw new QueryParseError(`a column operand's "col" must name a column`);
  }
  const right = filterColumn(scope, operand["col"], context.qualifiedOnly);
  for (const side of [left, right]) {
    if (side.column.type === "blob") {
      throw new QueryParseError(`"${side.ref}" is a blob and cannot appear in a predicate`);
    }
  }
  if (!comparableTypes(left.column, right.column)) {
    throw new QueryParseError(
      `"${left.ref}" is ${left.column.type} and "${right.ref}" is ${right.column.type}; ` +
        `a column operand must share its column's type`,
    );
  }
  if (COMPARISON_OPS.has(op) && !isOrderableColumn(left.column)) {
    throw new QueryParseError(`"${left.ref}" is a ${left.column.type} and has no ordering`);
  }
  return { kind: "compare", column: left.ref, op, other: right.ref };
}

/**
 * Whether two columns compare the same way on both engines.
 *
 * SQLite compares mismatched types loosely and Postgres raises an error, so
 * only a shared declared type, or two numeric types, is accepted.
 */
function comparableTypes(a: AppSyncableColumnInfo, b: AppSyncableColumnInfo): boolean {
  return a.type === b.type || (isNumericColumn(a) && isNumericColumn(b));
}

/** `exists` or `not_exists`: an array of subqueries, every one of which must hold. */
function parseExists(
  negated: boolean,
  spec: unknown,
  scope: Scope,
  context: PredicateContext,
): WhereTerm[] {
  const key = negated ? "not_exists" : "exists";
  scope.requireTables(key);
  if (!Array.isArray(spec) || spec.length === 0) {
    throw new QueryParseError(`${key} takes a non-empty JSON array of subqueries`);
  }
  return spec.map((raw) => {
    const sub = parseSubquery(raw, scope, context.depth + 1, key, false);
    if (!isCorrelated(sub, scope)) {
      throw new QueryParseError(
        `each ${key} subquery must compare a column of "${sub.qualifier}" with a column ` +
          `of an enclosing table, such as {"${sub.qualifier}.<column>": {"eq": {"col": ` +
          `"${scope.base.name}.id"}}}; otherwise it tests the whole table, not each row`,
      );
    }
    return { kind: "exists" as const, negated, sub };
  });
}

/** `{"a": {"in": {"table": …, "select": …}}}`, or `not_in`. */
function inSubqueryTerm(
  scope: Scope,
  outer: Resolved,
  negated: boolean,
  operand: Record<string, unknown>,
  context: PredicateContext,
): WhereTerm {
  const key = negated ? "not_in" : "in";
  const sub = parseSubquery(operand, scope, context.depth + 1, `a ${key} subquery`, true);
  const selected = sub.selectColumn;
  if (outer.column.type === "blob") {
    throw new QueryParseError(`"${outer.ref}" is a blob and cannot appear in a predicate`);
  }
  if (!comparableTypes(outer.column, selected.column)) {
    throw new QueryParseError(
      `"${outer.ref}" is ${outer.column.type} and the subquery selects ` +
        `"${selected.ref}", which is ${selected.column.type}; the two must share a type`,
    );
  }
  if (negated && !selected.column.notNull) {
    throw new QueryParseError(
      `a not_in subquery must select a NOT NULL column, because one null makes NOT IN ` +
        `match nothing; "${selected.ref}" may be null, so use not_exists instead`,
    );
  }
  return {
    kind: "in_subquery",
    column: outer.ref,
    negated,
    sub: { table: sub.table, qualifier: sub.qualifier, where: sub.where, select: selected.ref },
  };
}

function parseSubquery(
  raw: unknown,
  scope: Scope,
  depth: number,
  what: string,
  withSelect: true,
): Subquery & { readonly selectColumn: Resolved };
function parseSubquery(
  raw: unknown,
  scope: Scope,
  depth: number,
  what: string,
  withSelect: false,
): Subquery;
function parseSubquery(
  raw: unknown,
  scope: Scope,
  depth: number,
  what: string,
  withSelect: boolean,
): Subquery & { readonly selectColumn?: Resolved } {
  const tables = scope.requireTables(what);
  if (depth > MAX_SUBQUERY_DEPTH) {
    throw new QueryParseError(`subqueries nest at most ${MAX_SUBQUERY_DEPTH} levels deep`);
  }
  if (!isPlainObject(raw)) {
    throw new QueryParseError(`${what} must be a JSON object naming a table`);
  }
  refuseUnknownFields(
    raw,
    withSelect ? ["table", "as", "select", "where"] : ["table", "as", "where"],
    what,
  );
  if (typeof raw["table"] !== "string") {
    throw new QueryParseError(`${what} must name its table`);
  }
  const table = raw["table"];
  const schema = tables.schemaOf(table);
  const qualifier = qualifierFor(table, raw["as"], scope, tables);
  const inner = scope.with({ qualifier, schema });

  let where: WhereTerm[] = [];
  if (raw["where"] !== undefined) {
    if (!isPlainObject(raw["where"])) {
      throw new QueryParseError(`${what}'s where must be a JSON object`);
    }
    where = parsePredicates(raw["where"], inner, { qualifiedOnly: true, depth });
  }

  if (!withSelect) return { table, qualifier, where };

  if (typeof raw["select"] !== "string") {
    throw new QueryParseError(`${what} must select one column, as "${qualifier}.<column>"`);
  }
  const selectColumn = inner.resolve(raw["select"], true);
  if (selectColumn.qualifier !== qualifier) {
    throw new QueryParseError(
      `${what} selects a column of its own table "${qualifier}"; "${raw["select"]}" is not one`,
    );
  }
  if (selectColumn.name === SOFT_DELETE_COLUMN) {
    throw new QueryParseError(`"${SOFT_DELETE_COLUMN}" is owned by the server`);
  }
  return { table, qualifier, where, selectColumn };
}

/** Every column-operand pair in a term list, subqueries included. */
function comparePairs(terms: readonly WhereTerm[]): Array<readonly [ColumnRef, ColumnRef]> {
  const pairs: Array<readonly [ColumnRef, ColumnRef]> = [];
  for (const term of terms) {
    if (isWhereClause(term)) continue;
    if (term.kind === "compare") pairs.push([term.column, term.other]);
    else pairs.push(...comparePairs(term.sub.where));
  }
  return pairs;
}

/** The qualifiers a subquery defines: its own, and every nested subquery's. */
function innerQualifiers(sub: Subquery): Set<string> {
  const out = new Set([sub.qualifier]);
  for (const term of sub.where) {
    if (!isWhereClause(term) && term.kind !== "compare") {
      for (const q of innerQualifiers(term.sub)) out.add(q);
    }
  }
  return out;
}

/** Does some column operand inside the subquery tie it to an enclosing table? */
function isCorrelated(sub: Subquery, scope: Scope): boolean {
  const inside = innerQualifiers(sub);
  const base = scope.base.name;
  return comparePairs(sub.where).some(([a, b]) => {
    const qa = inside.has(qualifierOfRef(a, base));
    const qb = inside.has(qualifierOfRef(b, base));
    return qa !== qb;
  });
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
    // No second boolean guard here. `isOrderableColumn` now excludes the type,
    // so the check above catches a flag by its declaration rather than by the
    // JavaScript type of whatever `value` happened to normalize it to — which
    // also catches `order` and `min`/`max`, where a value-shaped guard never
    // ran at all.
    return { op: op as "lt" | "lte" | "gt" | "gte", value: bound as string | number };
  }

  switch (op) {
    case "eq":
      // The explicit spelling of the bare scalar, which a column operand
      // needs: `{"col": …}` at this position already means an operator map.
      return { op: "eq", value: value(column, operand) };

    case "ne":
      return { op: "ne", value: value(column, operand) };

    case "in":
    case "not_in": {
      if (!Array.isArray(operand)) {
        throw new QueryParseError(
          `${op} takes a JSON array or a subquery; "${name}" received something else`,
        );
      }
      if (operand.length === 0) {
        throw new QueryParseError(
          op === "in"
            ? `in with an empty list matches nothing; omit the predicate`
            : `not_in with an empty list matches everything; omit the predicate`,
        );
      }
      if (operand.length > MAX_IN_LIST) {
        throw new QueryParseError(
          `${op} takes at most ${MAX_IN_LIST} values; "${name}" received ${operand.length}`,
        );
      }
      const values = operand.map((v) => value(column, v));
      if (op === "in") return { op: "in", values };
      // One null in the list makes SQL's NOT IN unknown for every row, which
      // is an empty answer rather than an error.
      if (values.includes(null)) {
        throw new QueryParseError(
          `not_in cannot hold null, because NOT IN with a null matches nothing; ` +
            `add {"is": null} or {"ne": null} as a separate filter`,
        );
      }
      return { op: "not_in", values };
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

function parseWhere(scope: Scope, raw: string | undefined): WhereTerm[] {
  if (raw === undefined || raw.trim() === "") return [];
  const object = parseJsonParam("where", raw) as Record<string, unknown>;
  const terms = parsePredicates(object, scope, { qualifiedOnly: false, depth: 0 });

  const schema = scope.base;
  for (const required of schema.requiredFilters ?? []) {
    if (!terms.some((t) => isWhereClause(t) && t.column === required)) {
      throw new QueryParseError(
        `"${schema.name}" requires ${(schema.requiredFilters ?? [])
          .map((c) => `"${c}"`)
          .join(" and ")} in where; without them the query scans the whole table`,
      );
    }
  }

  return terms;
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

/**
 * Parse `join`, a JSON array of `{table, as?, kind, on}`.
 *
 * Each join extends the scope the next one sees, so an `on` may name the base
 * table, every earlier join and its own table. Every `on` must compare a column
 * of its own table with a column of an earlier one: the grammar has no cross
 * join, because a join whose `on` names only literals pairs every row with
 * every row.
 */
function parseJoins(scope: Scope, raw: string | undefined): { joins: JoinSpec[]; scope: Scope } {
  if (raw === undefined || raw.trim() === "") return { joins: [], scope };
  const tables = scope.requireTables("join");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new QueryParseError(
      `join must be JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new QueryParseError(`join must be a non-empty JSON array of joins`);
  }

  const joins: JoinSpec[] = [];
  let current = scope;
  for (const entry of parsed) {
    if (!isPlainObject(entry)) {
      throw new QueryParseError(`each join must be a JSON object naming a table`);
    }
    refuseUnknownFields(entry, ["table", "as", "kind", "on"], "a join");
    if (typeof entry["table"] !== "string") {
      throw new QueryParseError(`each join must name its table`);
    }
    const table = entry["table"];
    if (entry["kind"] !== "inner" && entry["kind"] !== "left") {
      throw new QueryParseError(`a join's kind must be "inner" or "left"`);
    }
    const kind = entry["kind"];
    const schema = tables.schemaOf(table);
    const qualifier = qualifierFor(table, entry["as"], current, tables);
    const earlier = new Set(current.qualifiers());
    const inScope = current.with({ qualifier, schema });

    if (!isPlainObject(entry["on"]) || Object.keys(entry["on"]).length === 0) {
      throw new QueryParseError(`the join of "${qualifier}" needs an on`);
    }
    const on = parsePredicates(entry["on"], inScope, { qualifiedOnly: true, depth: 0 });
    const base = scope.base.name;
    const linked = on.some((term) => {
      if (isWhereClause(term) || term.kind !== "compare") return false;
      const a = qualifierOfRef(term.column, base);
      const b = qualifierOfRef(term.other, base);
      return (a === qualifier && earlier.has(b)) || (b === qualifier && earlier.has(a));
    });
    if (!linked) {
      throw new QueryParseError(
        `the join of "${qualifier}" must compare one of its columns with a column of an ` +
          `earlier table, such as {"${qualifier}.<column>": {"eq": {"col": "${base}.id"}}}`,
      );
    }

    joins.push({ table, qualifier, kind, on });
    current = inScope;
  }
  return { joins, scope: current };
}

// ---------------------------------------------------------------------------
// select, order, limit
// ---------------------------------------------------------------------------

function parseSelect(scope: Scope, raw: string | undefined): ColumnRef[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const names = splitList(raw);
  if (names.length === 0) return null;
  const refs = names.map((name) => {
    const resolved = scope.resolve(name, false);
    if (resolved.name === SOFT_DELETE_COLUMN) {
      throw new QueryParseError(
        `"${SOFT_DELETE_COLUMN}" is owned by the server and cannot be projected`,
      );
    }
    return resolved.ref;
  });
  return [...new Set(refs)];
}

const ORDER_MODIFIERS = new Set(["asc", "desc", "nullsfirst", "nullslast"]);

/**
 * Parse `order`, e.g. `due.asc,id.desc.nullsfirst,programs.name.desc`.
 *
 * The null position may be given explicitly and is otherwise derived: nulls
 * last, whichever direction the key runs. Derived rather than left to the
 * engine because the two engines derive it differently, and stated on every
 * term in the parsed value so nothing downstream has to remember the rule.
 *
 * A term's name is one part or two. `isQualified` decides, from the first two
 * parts, whether they name a qualified column; the rest are modifiers.
 */
function parseOrder(
  raw: string | undefined,
  isQualified: (first: string, second: string) => boolean,
  resolve: (name: string) => ColumnRef,
): OrderTerm[] {
  if (raw === undefined || raw.trim() === "") return [];
  return splitList(raw).map((term) => {
    const parts = term.split(".");
    const width = parts.length >= 2 && isQualified(parts[0]!, parts[1]!) ? 2 : 1;
    const name = parts.slice(0, width).join(".");
    if (parts[0]!.length === 0) throw new QueryParseError(`order term "${term}" names no column`);
    const column = resolve(name);

    let direction: "asc" | "desc" = "asc";
    let nulls: "first" | "last" | null = null;
    for (const modifier of parts.slice(width)) {
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

/**
 * Whether `first.second` names a qualified column in a row query's order.
 *
 * A qualifier in scope wins, so `programs.name` is the joined column. A first
 * part that is not a qualifier, or a second part that is a modifier, reads as a
 * bare name followed by modifiers, as before joins existed.
 */
function rowOrderIsQualified(scope: Scope): (first: string, second: string) => boolean {
  return (first, second) => scope.has(first) && !ORDER_MODIFIERS.has(second);
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

function parseAggregate(scope: Scope, raw: string, groupBy: readonly ColumnRef[]): AggregateTerm[] {
  const schema = scope.base;
  const object = parseJsonParam("aggregate", raw) as Record<string, unknown>;
  const entries = Object.entries(object);
  if (entries.length === 0) {
    throw new QueryParseError(`aggregate is an empty object and asks nothing`);
  }

  return entries.map(([name, spec]) => {
    // An output name colliding with a column name would make one key in the
    // result row mean two things, and which one won would be the engine's
    // choice rather than the grammar's.
    if ((schema.columns ?? []).some((c) => c.name === name) || groupBy.includes(name)) {
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
      const resolved = aggregateColumn(scope, name, target);
      return { name, fn: "count" as const, col: resolved.ref, distinct: distinct !== undefined };
    }

    if (distinct !== undefined) {
      throw new QueryParseError(`distinct applies to count only, not to ${fn}`);
    }
    if (typeof col !== "string") {
      throw new QueryParseError(`aggregate["${name}"].col must name a column for ${fn}`);
    }
    const resolved = aggregateColumn(scope, name, col);
    const column = resolved.column;
    if (fn === "sum" || fn === "avg") {
      if (!isNumericColumn(column)) {
        throw new QueryParseError(`${fn} needs a numeric column; "${col}" is ${column.type}`);
      }
    } else if (!isOrderableColumn(column)) {
      throw new QueryParseError(`${fn} needs an orderable column; "${col}" is ${column.type}`);
    }
    return { name, fn: fn as AggregateFn, col: resolved.ref, distinct: false };
  });
}

function aggregateColumn(scope: Scope, outputName: string, column: string): Resolved {
  const resolved = scope.resolve(column, false);
  if (resolved.name === SOFT_DELETE_COLUMN) {
    throw new QueryParseError(
      `aggregate["${outputName}"] names "${SOFT_DELETE_COLUMN}", which the server owns`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * Parse a request's parameters against the table it names.
 *
 * `options.tables` enables joins and subqueries over the calling app's other
 * tables. Without it, every multi-table form is refused.
 */
export function parseQuery(
  schema: QueryTableSchema,
  params: QueryParams,
  options: ParseOptions = {},
): ParsedQuery {
  const { joins, scope } = parseJoins(Scope.of(schema, options.tables), params.join);
  const where = parseWhere(scope, params.where);
  const limit = parseLimit(params.limit);

  if (params.aggregate !== undefined && params.aggregate.trim() !== "") {
    return parseAggregateQuery(scope, params, joins, where, limit);
  }
  return parseRowQuery(scope, params, joins, where, limit);
}

function parseRowQuery(
  scope: Scope,
  params: QueryParams,
  joins: JoinSpec[],
  where: WhereTerm[],
  limit: number,
): RowQuery {
  const schema = scope.base;
  const select = parseSelect(scope, params.select);
  // Every column of every joined table would repeat the parent's columns on
  // every child row, and two tables' `id` would need a rule to stay apart.
  // Requiring `select` leaves room to define an omitted one later.
  if (joins.length > 0 && select === null) {
    throw new QueryParseError(`a query with join must name its columns in select`);
  }
  const requested = parseOrder(params.order, rowOrderIsQualified(scope), (name) => {
    if (!name.includes(".")) {
      if (name === SOFT_DELETE_COLUMN) {
        throw new QueryParseError(`"${SOFT_DELETE_COLUMN}" is owned by the server`);
      }
      const resolved = orderColumnOf(schema, name);
      if (!isOrderableColumn(resolved)) {
        throw new QueryParseError(`"${name}" is a ${resolved.type} and has no ordering`);
      }
      return name;
    }
    const resolved = scope.resolve(name, false);
    if (resolved.name === SOFT_DELETE_COLUMN) {
      throw new QueryParseError(`"${SOFT_DELETE_COLUMN}" is owned by the server`);
    }
    if (!isOrderableColumn(resolved.column)) {
      throw new QueryParseError(`"${name}" is a ${resolved.column.type} and has no ordering`);
    }
    return resolved.ref;
  });

  // The primary key completes the ordering. A keyset cursor has to name exactly
  // one row and a sort key does not, so a page ordered by `due` alone would
  // lose or repeat rows that share a `due` across the page boundary. A join
  // can return several rows per base row, so every joined table's key follows:
  // the tuple of all primary keys names one result row. The parser cannot tell
  // a to-one join from a to-many one, so it appends every join's key.
  const order: OrderTerm[] = [...requested];
  const keys = [
    ...schema.pkColumns,
    ...joins.flatMap((join) =>
      scopeSchema(scope, join).pkColumns.map((pk) => `${join.qualifier}.${pk}`),
    ),
  ];
  for (const pk of keys) {
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

  return {
    mode: "rows",
    table: schema.name,
    select,
    joins,
    where,
    order,
    limit,
    pageToken,
    include,
  };
}

/** The schema of a joined table, which the scope already resolved once. */
function scopeSchema(scope: Scope, join: JoinSpec): QueryTableSchema {
  return scope.requireTables("join").schemaOf(join.table);
}

function parseAggregateQuery(
  scope: Scope,
  params: QueryParams,
  joins: JoinSpec[],
  where: WhereTerm[],
  limit: number,
): AggregateQuery {
  const schema = scope.base;
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

  // `select` is the GROUP BY list. SQL requires every non-aggregate output
  // column to appear in it, so the two lists are one list — which also makes
  // `SELECT max(x), y` unrepresentable rather than differently-answered.
  const groupBy = parseSelect(scope, params.select) ?? [];
  const aggregates = parseAggregate(scope, params.aggregate!, groupBy);
  const outputs = new Set([...groupBy, ...aggregates.map((a) => a.name)]);

  const order = parseOrder(
    params.order,
    (first, second) =>
      outputs.has(`${first}.${second}`) || (first === schema.name && outputs.has(second)),
    (name) => {
      // A qualified base-table group key comes back bare, so the order names
      // it bare too.
      const normalized =
        name.startsWith(`${schema.name}.`) && !outputs.has(name)
          ? name.slice(schema.name.length + 1)
          : name;
      if (!outputs.has(normalized)) {
        throw new QueryParseError(
          `order may name a grouping column or an aggregate output; "${name}" is neither`,
        );
      }
      return normalized;
    },
  );

  return {
    mode: "aggregate",
    table: schema.name,
    groupBy,
    aggregates,
    joins,
    where,
    order,
    limit,
  };
}
