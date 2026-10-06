/**
 * The shared plane's query routes, minus the transport.
 *
 * Both data servers expose the same two routes over the same two tables, and
 * the only interesting thing either route does is turn the caller's grants into
 * a predicate. Written once here, for the reason the parser and the SQL
 * compiler are written once: the four hand-written grammars this work replaced
 * had already drifted, and an authorization rule is the last thing that should
 * exist in two copies.
 *
 * What a server still owns is its own transport — reading parameters off a URL
 * or an event, and writing a status code — and its own grant source.
 *
 * ## The rule these functions implement
 *
 * Every queryable access path to shared data carries the caller's grant
 * discriminant in a position the index can use. `record_type` is a column of
 * both tables, so the grant compiles to an ordinary `IN` predicate ANDed in
 * beside the caller's own — the grant rides *inside* the access path rather
 * than filtering what the access path returned.
 *
 * The predicate is omitted entirely under `allAccess`, which is the
 * User-Data-Owner: its authorization is by app id and cannot be written as a
 * finite set of types, so an `IN` list would be a narrower rule wearing the
 * same clothes.
 */

import {
  typeCategory,
  type AccessGrants,
  type Category,
  hasMetadataTable,
} from "@starkeep/protocol-primitives";
import {
  sharedQueryDiscriminant,
  sharedQuerySchema,
  withDeclaredProjection,
  type SharedQueryTarget,
} from "@starkeep/storage-adapter";
import { ApiError } from "../errors.js";
import { parseQuery } from "./parse.js";
import type { ParsedQuery, WhereClause } from "./types.js";
import { queryParamsFrom, rawParam, type ParamSource } from "./params.js";
import type { SoftDeletedScope } from "@starkeep/storage-adapter";

/** A parsed query and the server-owned predicate that goes with it. */
export interface SharedQueryPlan {
  readonly target: SharedQueryTarget;
  readonly query: ParsedQuery;
  /** Empty only under `allAccess`, where there is nothing to restrict. */
  readonly serverWhere: readonly WhereClause[];
  /**
   * Which side of the tombstone to read, from `?deleted=`. `exclude` by default.
   *
   * This is the gate the metadata hard delete used to stand in for. A metadata
   * row is now tombstoned with its record rather than destroyed, and this route
   * reads the table directly with no view of any record, so the predicate here is
   * the only thing keeping a deleted record's dimensions out of the answer. A
   * Trash view passes `only` to show what it is about to lose.
   */
  readonly softDeleted: SoftDeletedScope;
}

/**
 * Read `?deleted=`, naming the three readings rather than accepting anything.
 *
 * A misspelling is a 400 rather than a silent `exclude`, for the reason the
 * records route gives: a view that asked for tombstones and got live rows looks
 * like it is working.
 */
function softDeletedScope(raw: string | undefined): SoftDeletedScope {
  if (raw === undefined) return "exclude";
  if (raw === "exclude" || raw === "only" || raw === "include") return raw;
  throw new ApiError(`deleted must be "exclude", "only" or "include" (got "${raw}")`, 400);
}

/**
 * Plan a query over one category's metadata table.
 *
 * The category is the caller's to name and the *types within it* are the gate.
 * Photos declares seventeen of the nineteen image types and deliberately
 * declines `image/svg` and `image/ico`, so "the image metadata table" and "the
 * image metadata Photos may read" are two different sets of rows, and the
 * difference is exactly what this predicate expresses.
 *
 * Throws 403 when the caller holds no readable type in the category, rather
 * than answering an empty page: the caller named a resource, and a page of
 * nothing would say "the library is empty" where the truth is "not yours".
 */
export function planMetadataQuery(
  category: Category,
  grants: AccessGrants,
  source: ParamSource,
): SharedQueryPlan {
  if (!hasMetadataTable(category)) {
    // Drive-only, ungrantable, and it has no metadata table to query.
    throw new ApiError(`Category "${category}" has no metadata table`, 400);
  }
  const target: SharedQueryTarget = { kind: "metadata", category };
  return plan(target, grants, source, readableTypesIn(grants, category));
}

/**
 * Plan a query over `shared.record_labels`.
 *
 * `app_id` and `key` are required filters, enforced by the schema rather than
 * here — the reverse index is `(app_id, key, deleted_at, value, record_id)`, so
 * a query pinning neither scans every app's assertions about every record.
 *
 * The caller's own app id is not one of them. A label is a *cross-app*
 * assertion and is readable by anyone who may read the labelled record, which
 * is what `record_type IN (…)` decides. Restricting a caller to its own labels
 * would break the one thing the table exists for.
 */
export function planLabelQuery(grants: AccessGrants, source: ParamSource): SharedQueryPlan {
  return plan({ kind: "labels" }, grants, source, [...grants.readableTypes].sort());
}

/** The parameters these two routes own rather than the grammar. */
const SHARED_READ_SERVER_PARAMS: readonly string[] = ["deleted"];

function plan(
  target: SharedQueryTarget,
  grants: AccessGrants,
  source: ParamSource,
  readable: readonly string[],
): SharedQueryPlan {
  if (!grants.allAccess && readable.length === 0) {
    throw new ApiError("Forbidden", 403);
  }
  const schema = sharedQuerySchema(target);
  // The projection is narrowed to the declared columns before it leaves here,
  // so `record_type` — present on every row, and the thing the predicate below
  // is built on — is not returned by a caller's bare `SELECT *`.
  // `deleted` is the route's parameter, not the grammar's: the parser is given
  // the caller's own `where`, `order` and the rest, and would refuse a column the
  // schema does not declare — which `deleted_at` deliberately is not.
  const query = withDeclaredProjection(
    parseQuery(schema, queryParamsFrom(source, SHARED_READ_SERVER_PARAMS)),
    schema,
  );
  return {
    target,
    query,
    softDeleted: softDeletedScope(rawParam(source, "deleted")),
    serverWhere: grants.allAccess
      ? []
      : [
          {
            column: sharedQueryDiscriminant(target),
            predicate: { op: "in", values: readable },
          },
        ],
  };
}

/** The caller's readable types that live in one category, in a stable order. */
function readableTypesIn(grants: AccessGrants, category: Category): string[] {
  return [...grants.readableTypes].filter((t) => typeCategory(t) === category).sort();
}
