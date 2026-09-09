/**
 * The keyset continuation, encoded and decoded.
 *
 * A cursor rather than an `OFFSET`, because an offset re-reads and re-discards
 * everything before the page and gives a different answer when a row is
 * inserted mid-walk. A keyset walks forward from a row it names, which is what
 * makes "the next page" mean the same thing whatever happened behind it — and
 * the reason `offset` waits for a caller who genuinely needs random access.
 *
 * The token is opaque by contract. Its shape is the server's, and an app that
 * parsed one would be depending on a decision this file is free to change.
 */

import { QueryParseError, type OrderTerm, type PageToken, type QueryValue } from "./app-query-types.js";

/**
 * A stable name for one ordering.
 *
 * A token carries it so a token cut under `due asc, id asc` and replayed under
 * `due desc, id asc` is refused. Honouring it would silently skip rows, which
 * is the failure keyset pagination exists to prevent; dropping it would
 * silently restart the walk and repeat them.
 */
/**
 * Named `appOrderSignature` because `query-cursor.ts` already exports an
 * `orderSignature` for the shared-record cursor. The two encode different
 * orderings for different tables and must not be confused for each other.
 */
export function appOrderSignature(order: readonly OrderTerm[]): string {
  return order.map((t) => `${t.column}.${t.direction}.${t.nulls}`).join(",");
}

export function encodePageToken(token: PageToken): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

/**
 * Decode a token, or reject.
 *
 * Every failure is a rejection rather than a silent first page: a caller that
 * asked to continue and got the beginning has no way to notice, and would page
 * forever.
 */
export function decodePageToken(raw: string, order: readonly OrderTerm[]): PageToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new QueryParseError("page_token is not a token this server issued");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as PageToken).order !== "string" ||
    !Array.isArray((parsed as PageToken).keys)
  ) {
    throw new QueryParseError("page_token is not a token this server issued");
  }
  const token = parsed as PageToken;
  const signature = appOrderSignature(order);
  if (token.order !== signature) {
    throw new QueryParseError(
      `page_token was cut under a different ordering (${token.order}); ` +
        `re-request the first page under ${signature}`,
    );
  }
  if (token.keys.length !== order.length) {
    throw new QueryParseError("page_token does not describe this ordering");
  }
  for (const key of token.keys) {
    if (typeof key !== "object" || key === null || typeof key.isNull !== "boolean") {
      throw new QueryParseError("page_token is not a token this server issued");
    }
  }
  return token;
}

/**
 * The token that follows a page, cut from the last row it handed out.
 *
 * Reads the reserved aliases the compiler selected rather than the column
 * names, for two reasons: a projection may not have selected the ordering
 * columns at all, and the value the database ordered on is the only value the
 * keyset predicate will compare against. Recomputing it from the row would be a
 * second derivation free to disagree with the first.
 */
export function pageTokenFrom(
  order: readonly OrderTerm[],
  lastRow: Record<string, unknown>,
  aliasFor: (index: number) => string,
): PageToken {
  return {
    order: appOrderSignature(order),
    keys: order.map((term, index) => {
      const raw = lastRow[aliasFor(index)] ?? lastRow[term.column];
      const value = raw === undefined ? null : (raw as QueryValue);
      return { isNull: value === null, value };
    }),
  };
}
