/**
 * The shared plane's tables, described for the one query parser.
 *
 * The app-syncable plane learns a table's shape from the namespace registry an
 * installer wrote from the app's manifest. The shared plane has no registry and
 * no manifest: its three queryable tables are declared in this codebase, so
 * they describe themselves here, in the vocabulary
 * {@link QueryTableSchema} already speaks.
 *
 * ## Why the declared column list is the whole contract
 *
 * A column absent from `columns` cannot be filtered, ordered, aggregated or
 * projected — the parser refuses a name it does not find, and
 * {@link withDeclaredProjection} narrows a bare `SELECT *` to exactly the
 * declared list. That is what lets `record_type` be present on every metadata
 * row, carry the grant predicate, and still not be part of the surface an app
 * can address.
 *
 * ## Why `deleted_at` never appears
 *
 * The server owns the soft-delete predicate on every table that has the column,
 * and the parser refuses the name outright. The metadata tables do not have the
 * column at all, which is what {@link sharedQueryExcludesSoftDeleted} reports to
 * the SQL compiler.
 */

import {
  getCategory,
  METADATA_DISCRIMINANT_COLUMN,
  pgMetadataTableName,
  sqliteMetadataTableName,
  type Category,
  type CategoryDef,
} from "@starkeep/protocol-primitives";
import type { AppColumnInfo, ParsedQuery, QueryTableSchema, RowQuery } from "./app-query-types.js";

/**
 * Which shared table a parsed query runs against.
 *
 * A tagged value rather than a table name, because the physical name differs
 * per engine (`shared.records` against `shared_records`) and the per-category
 * metadata tables are ten tables behind one schema shape. Naming the target
 * rather than the table keeps every caller — route handler, adapter, test —
 * from having to know which engine it is talking to.
 */
export type SharedQueryTarget =
  | { readonly kind: "records" }
  | { readonly kind: "labels" }
  | { readonly kind: "metadata"; readonly category: Category };

/** The two spellings of one physical table. */
export type SharedQueryDialect = "pg" | "sqlite";

const text = (name: string, notNull: boolean, primaryKey = false): AppColumnInfo => ({
  name,
  type: "text",
  notNull,
  primaryKey,
});

/**
 * `shared.records`, minus the columns no caller may address.
 *
 * `deleted_at` is the server's. `created_at` and `updated_at` are serialized
 * HLCs rather than wall-clock times, so they are declared `text` and listed in
 * {@link SHARED_RECORD_PROJECTION_ONLY}: a page ordered by sync time is a real
 * question a UI asks, and a predicate over a sync-internal clock is not a
 * promise the platform makes.
 */
const SHARED_RECORD_COLUMNS: readonly AppColumnInfo[] = [
  text("id", true, true),
  text("type", true),
  text("created_at", true),
  text("updated_at", true),
  text("node_id", true),
  { name: "version", type: "integer", notNull: true, primaryKey: false },
  text("content_hash", true),
  text("object_storage_key", true),
  text("mime_type", false),
  // `bigint` on Postgres and INTEGER on SQLite, which is already 64-bit. The
  // logical type is what makes the Postgres side hand back a number rather than
  // the string node-postgres returns for int8.
  { name: "size_bytes", type: "bigint", notNull: true, primaryKey: false },
  text("original_filename", false),
  text("origin_app_id", true),
  text("parent_id", false),
];

/**
 * `shared.record_labels`.
 *
 * `record_type` is declared and filterable here, unlike on the metadata tables:
 * "labels on images" is a question worth asking, and the server's own
 * `record_type IN (…)` predicate is ANDed in beside the caller's, so a caller
 * can only ever narrow what it may already read.
 */
const RECORD_LABEL_COLUMNS: readonly AppColumnInfo[] = [
  text("record_id", true, true),
  text("app_id", true, true),
  text("key", true, true),
  text("value", true, true),
  text("record_type", true),
  text("created_at", true),
  text("updated_at", true),
  text("node_id", true),
];

/**
 * Columns a caller may project and order but never filter, beyond the two the
 * parser refuses on every table.
 *
 * `created_at` is a serialized HLC on both shared tables — the same
 * sync-internal clock `updated_at` is, and the same reason applies.
 */
const SHARED_RECORD_PROJECTION_ONLY: readonly string[] = ["created_at"];

/**
 * The label table's tiebreaker, which is not its primary key.
 *
 * The primary key is `(record_id, app_id, key, value)` and the reverse index is
 * `(app_id, key, deleted_at, value, record_id)`. `app_id` and `key` are
 * required filters, so both are pinned to a constant on every query this schema
 * ever answers — which leaves `(value, record_id)` both a total order over the
 * result and the residual order of the index. Completing the ordering with the
 * literal primary key instead would name the same rows in an order no index
 * produces, turning every page into a sort.
 */
const RECORD_LABEL_ORDER_KEY: readonly string[] = ["value", "record_id"];

/**
 * A per-category metadata table, as `CATEGORIES` declares it.
 *
 * `record_type` is deliberately absent. It is on every row and it carries the
 * grant predicate, but it is the server's discriminant rather than part of the
 * app-facing surface: a caller that could filter it could ask about types it
 * was not granted and read the shape of the answer off the row count, and a
 * caller that could project it would be reading an authorization decision back
 * out of a data row.
 */
function metadataColumns(def: CategoryDef): readonly AppColumnInfo[] {
  return [
    text("record_id", true, true),
    ...def.metadataColumns.map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.nullable === false,
      primaryKey: false,
    })),
  ];
}

/** The parser's description of a shared table. */
export function sharedQuerySchema(target: SharedQueryTarget): QueryTableSchema {
  if (target.kind === "records") {
    return {
      name: "records",
      columns: SHARED_RECORD_COLUMNS,
      pkColumns: ["id"],
      projectionOnly: SHARED_RECORD_PROJECTION_ONLY,
      includable: [],
    };
  }
  if (target.kind === "labels") {
    return {
      name: "record_labels",
      columns: RECORD_LABEL_COLUMNS,
      pkColumns: RECORD_LABEL_ORDER_KEY,
      // The cost ceiling, expressed as a query precondition. The reverse index
      // is `(app_id, key, deleted_at, value, record_id)`, so a query that pins
      // neither scans every app's assertions about every record.
      requiredFilters: ["app_id", "key"],
      projectionOnly: SHARED_RECORD_PROJECTION_ONLY,
      includable: [],
    };
  }
  const def = getCategory(target.category);
  if (!def) throw new Error(`Unknown category "${target.category}"`);
  if (def.metadataColumns.length === 0) {
    // `other` is the only one, and it has no metadata table to query.
    throw new Error(`Category "${target.category}" has no metadata table`);
  }
  return {
    name: `record_${target.category}_metadata`,
    columns: metadataColumns(def),
    pkColumns: ["record_id"],
    includable: [],
  };
}

/** The physical table one target names on one engine. */
export function sharedQueryTableName(
  target: SharedQueryTarget,
  dialect: SharedQueryDialect,
): string {
  switch (target.kind) {
    case "records":
      return dialect === "pg" ? "shared.records" : "shared_records";
    case "labels":
      return dialect === "pg" ? "shared.record_labels" : "shared_record_labels";
    case "metadata":
      return dialect === "pg"
        ? pgMetadataTableName(target.category)
        : sqliteMetadataTableName(target.category);
  }
}

/**
 * Whether the target's table carries `deleted_at`.
 *
 * The metadata tables do not: a metadata row is derived state keyed by
 * `record_id`, deleted outright with its record rather than tombstoned, because
 * nothing syncs it independently of the record it rides on.
 */
export function sharedQueryExcludesSoftDeleted(target: SharedQueryTarget): boolean {
  return target.kind !== "metadata";
}

/**
 * The grant discriminant on the target's table.
 *
 * `type` on `shared.records` and `record_type` on the other two. The server's
 * predicate is built over this column, and it is the reason each of the three
 * tables can carry the caller's grant inside its own access path rather than
 * filtering what a scan returned.
 */
export function sharedQueryDiscriminant(target: SharedQueryTarget): string {
  return target.kind === "records" ? "type" : METADATA_DISCRIMINANT_COLUMN;
}

/**
 * Pin a bare `SELECT *` to the schema's declared columns.
 *
 * `select: null` compiles to `selectAll()`, which returns every *physical*
 * column — including the ones the schema deliberately does not declare, chiefly
 * `record_type` on a metadata table. Narrowing here makes the declared list the
 * whole contract in both directions: what a caller may address is exactly what
 * comes back.
 *
 * Aggregate queries need none of this, because their output columns are their
 * `GROUP BY` list, which the parser already checked against the schema.
 */
export function withDeclaredProjection(
  query: ParsedQuery,
  schema: QueryTableSchema,
): ParsedQuery {
  if (query.mode !== "rows" || query.select !== null) return query;
  const select = schema.columns.map((c) => c.name);
  return { ...query, select } satisfies RowQuery;
}
