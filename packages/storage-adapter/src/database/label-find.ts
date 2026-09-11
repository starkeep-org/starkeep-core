/**
 * The reverse label query, as a parsed query.
 *
 * `findByLabel` answers "which records did app A label with key K", and it used
 * to compile its own SQL, cut its own cursor and sort its own in-memory copy in
 * the mock. All three were correct and all three were a second implementation
 * of something the query grammar already expresses: the labels schema declares
 * `app_id` and `key` as required filters, and completes every ordering with
 * `(value, record_id)` — the reverse index's own residual order, and exactly
 * the order the hand-written path spelled.
 *
 * So the reverse query is built here as a {@link RowQuery} and run through
 * `DatabaseAdapter.queryShared`, which is the same compiler, the same keyset
 * predicate and the same page token the `/data/labels` route already uses.
 * One access path, one cursor convention, one conformance suite.
 *
 * ## What the caller gets that it did not have
 *
 * The page token is the grammar's, so a token cut here continues a query issued
 * at `/data/labels` with no order parameter, and the other way round. The two
 * were the same page in two encodings before.
 *
 * ## What the caller loses
 *
 * A malformed token is now a rejection rather than a silent first page. That is
 * the grammar's contract and the better one: a caller that asked to continue
 * and got the beginning has no way to notice, and pages forever.
 */

import { decodePageToken } from "./app-page-token.js";
import type {
  OrderTerm,
  ParsedQueryResult,
  RowQuery,
  WhereClause,
} from "./app-query-types.js";
import { rowToLabel, type LabelRow } from "./label-row.js";
import { sharedQuerySchema, type SharedQueryTarget } from "./shared-query-schemas.js";
import type { FindByLabelQuery, FindByLabelResult } from "./types.js";

/** The target every function here runs against. */
export const LABEL_QUERY_TARGET: SharedQueryTarget = { kind: "labels" };

export const DEFAULT_FIND_LIMIT = 50;

const LABEL_SCHEMA = sharedQuerySchema(LABEL_QUERY_TARGET);

/**
 * The ordering, taken from the schema rather than restated.
 *
 * The parser completes a row query with the table's primary key when the caller
 * names no order, and the labels schema declares `(value, record_id)` as that
 * key for the reason `shared-query-schemas.ts` gives: `app_id` and `key` are
 * pinned on every label query, so the index's residual order *is* a total order
 * over the result. Deriving it here is what keeps a token cut by this path and
 * one cut by `/data/labels` interchangeable — they carry the same signature
 * because they are the same ordering, not because two lists happen to match.
 */
const LABEL_ORDER: readonly OrderTerm[] = LABEL_SCHEMA.pkColumns.map((column) => ({
  column,
  direction: "asc",
  nulls: "last",
}));

/** A reverse label read, parsed: the caller's query and the server's predicate. */
export interface LabelFindPlan {
  readonly query: RowQuery;
  /**
   * The caller's read grant, as a predicate on `record_type`.
   *
   * Separate from `query.where` because it is the server's and a caller cannot
   * write it — the same separation `queryShared` draws everywhere else. Empty
   * means all-access, which is the User-Data-Owner and nobody else.
   */
  readonly serverWhere: readonly WhereClause[];
}

/**
 * Plan one reverse label read.
 *
 * Returns `null` when the query cannot match anything — a caller holding no
 * readable type — so every adapter short-circuits identically instead of
 * compiling a `record_type in ()` the two dialects disagree about.
 *
 * Throws {@link QueryParseError} for a cursor this server did not issue, or one
 * cut under a different ordering.
 */
export function planFindByLabel(query: FindByLabelQuery): LabelFindPlan | null {
  const where: WhereClause[] = [
    { column: "app_id", predicate: { op: "eq", value: query.appId } },
    { column: "key", predicate: { op: "eq", value: query.key } },
  ];
  // Omitted value = presence filter (any value, flags included); supplied =
  // exact match, and `""` matches bare flags. See FindByLabelQuery.value for
  // why collapsing the two returns a superset that looks like it works.
  if (query.value !== undefined) {
    where.push({ column: "value", predicate: { op: "eq", value: query.value } });
  }

  let serverWhere: readonly WhereClause[] = [];
  if (query.readableTypes !== undefined) {
    const values = [...query.readableTypes].sort();
    if (values.length === 0) return null;
    serverWhere = [{ column: "record_type", predicate: { op: "in", values } }];
  }

  return {
    query: {
      mode: "rows",
      table: LABEL_SCHEMA.name,
      // Every column, because the caller wants a `RecordLabel` rather than a
      // projection: `deleted_at` is not a column the schema declares, and
      // `rowToLabel` is total over the stored row.
      select: null,
      where,
      order: LABEL_ORDER,
      limit: query.limit ?? DEFAULT_FIND_LIMIT,
      pageToken:
        query.cursor === undefined || query.cursor.trim() === ""
          ? null
          : decodePageToken(query.cursor, LABEL_ORDER),
      include: [],
    },
    serverWhere,
  };
}

/** The page `queryShared` returned, as {@link FindByLabelResult}. */
export function labelPageFrom(result: ParsedQueryResult): FindByLabelResult {
  if (result.mode !== "rows") {
    throw new Error("planFindByLabel builds a row query; queryShared answered an aggregate");
  }
  return {
    labels: result.rows.map((row) => rowToLabel(row as unknown as LabelRow)),
    // `truncated` is "rows were left behind", which is what `hasMore` has always
    // meant here. The response budget can now set it on a short page, which the
    // contract already allowed: page until `nextCursor` is null.
    hasMore: result.truncated,
    nextCursor: result.pageToken,
  };
}

/** The answer for a caller that can read nothing at all. */
export function emptyLabelPage(): FindByLabelResult {
  return { labels: [], nextCursor: null, hasMore: false };
}
