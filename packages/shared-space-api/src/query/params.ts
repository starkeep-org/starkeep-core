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

/** Where a request's parameters come from, whatever transport carried them. */
export type ParamSource = URLSearchParams | Record<string, string | undefined>;

/** The named parameters of a request, as a flat map. */
export function entriesOf(source: ParamSource): Array<[string, string]> {
  return source instanceof URLSearchParams
    ? [...source.entries()]
    : Object.entries(source).filter((e): e is [string, string] => e[1] !== undefined);
}

/** One raw parameter, unparsed. */
export function rawParam(source: ParamSource, name: string): string | undefined {
  return source instanceof URLSearchParams
    ? (source.get(name) ?? undefined)
    : source[name];
}

/**
 * Collect the grammar's parameters, rejecting anything else.
 *
 * Takes either a `URLSearchParams` (the local server) or a flat record (the
 * cloud handler, which receives API Gateway's already-parsed map), so one
 * function serves both and neither has to spell the parameter list itself.
 *
 * `serverParams` names parameters the *route* owns rather than the grammar —
 * `deleted` on the shared plane's two read routes. They are accepted and left
 * out of the result, because the parser would refuse a name the table's schema
 * does not declare, and the columns these choose between are deliberately
 * undeclared. A route that does not name one keeps rejecting it, so a parameter
 * can never be accepted by a route that then ignores it.
 */
export function queryParamsFrom(
  source: ParamSource,
  serverParams: readonly string[] = [],
): QueryParams {
  const out: Record<string, string> = {};
  for (const [name, value] of entriesOf(source)) {
    if (serverParams.includes(name)) continue;
    if (!(RESERVED as readonly string[]).includes(name)) {
      throw new QueryParseError(
        `"${name}" is not a query parameter. Filters go under where as JSON, e.g. ` +
          `where={"${name}":${JSON.stringify(value)}}. ` +
          `Parameters: ${[...RESERVED, ...serverParams].join(", ")}`,
      );
    }
    out[name] = value;
  }
  return out as QueryParams;
}
