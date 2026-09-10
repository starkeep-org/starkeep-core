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
} from "@starkeep/protocol-primitives";
import {
  sharedQueryDiscriminant,
  sharedQuerySchema,
  withDeclaredProjection,
  type SharedQueryTarget,
} from "@starkeep/storage-adapter";
import { ApiError } from "../errors.js";
import { parseQuery } from "./parse.js";
import type { ParsedQuery, QueryParams, WhereClause } from "./types.js";

/** A parsed query and the server-owned predicate that goes with it. */
export interface SharedQueryPlan {
  readonly target: SharedQueryTarget;
  readonly query: ParsedQuery;
  /** Empty only under `allAccess`, where there is nothing to restrict. */
  readonly serverWhere: readonly WhereClause[];
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
  params: QueryParams,
): SharedQueryPlan {
  if (category === "other") {
    // Drive-only, ungrantable, and it has no metadata table to query.
    throw new ApiError(`Category "other" has no metadata table`, 400);
  }
  const target: SharedQueryTarget = { kind: "metadata", category };
  return plan(target, grants, params, readableTypesIn(grants, category));
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
export function planLabelQuery(grants: AccessGrants, params: QueryParams): SharedQueryPlan {
  return plan({ kind: "labels" }, grants, params, [...grants.readableTypes].sort());
}

function plan(
  target: SharedQueryTarget,
  grants: AccessGrants,
  params: QueryParams,
  readable: readonly string[],
): SharedQueryPlan {
  if (!grants.allAccess && readable.length === 0) {
    throw new ApiError("Forbidden", 403);
  }
  const schema = sharedQuerySchema(target);
  // The projection is narrowed to the declared columns before it leaves here,
  // so `record_type` — present on every row, and the thing the predicate below
  // is built on — is not returned by a caller's bare `SELECT *`.
  const query = withDeclaredProjection(parseQuery(schema, params), schema);
  return {
    target,
    query,
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
