/**
 * Request parameters, narrowed to the grammar's own.
 *
 * Every top-level parameter name is reserved by construction, which is what
 * lets the filters live under `where` with no sigil to keep them apart from
 * column names. That only holds if an unrecognized name is an error: the
 * grammar this replaces read *every* query parameter as an equality filter, so
 * `?deck_id=d1` meant something then and would mean nothing now. Silently
 * ignoring it would answer the whole table to a caller that asked for one deck.
 */

import { QueryParseError, type QueryParams } from "./types.js";

const RESERVED = ["where", "select", "aggregate", "order", "limit", "page_token", "include"] as const;

/**
 * Collect the grammar's parameters, rejecting anything else.
 *
 * Takes either a `URLSearchParams` (the local server) or a flat record (the
 * cloud handler, which receives API Gateway's already-parsed map), so one
 * function serves both and neither has to spell the parameter list itself.
 */
export function queryParamsFrom(
  source: URLSearchParams | Record<string, string | undefined>,
): QueryParams {
  const entries: Array<[string, string]> =
    source instanceof URLSearchParams
      ? [...source.entries()]
      : Object.entries(source).filter((e): e is [string, string] => e[1] !== undefined);

  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!(RESERVED as readonly string[]).includes(name)) {
      throw new QueryParseError(
        `"${name}" is not a query parameter. Filters go under where as JSON, e.g. ` +
          `where={"${name}":${JSON.stringify(value)}}. ` +
          `Parameters: ${RESERVED.join(", ")}`,
      );
    }
    out[name] = value;
  }
  return out as QueryParams;
}
