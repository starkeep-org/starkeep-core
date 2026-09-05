/**
 * The `query` pagination cursor.
 *
 * ## Why a bare record id was wrong
 *
 * The cursor used to be the last row's `id`, and the predicate that consumed it
 * was `id > cursor` — compiled regardless of the `ORDER BY` the same query
 * built. That pair is correct for exactly one ordering, the default `id asc`,
 * and silently wrong for every other: a page ordered `created_at desc` and
 * filtered `id > <some id>` is not the continuation of anything, it is an
 * arbitrary subset of the table. Records whose id sorts below the cursor are
 * skipped no matter where they fall in the requested order, and records above
 * it repeat.
 *
 * Nothing caught it because a short page is not an error and a wrong page is
 * still a page. The phone's library grid was the first caller to page a sorted
 * query, and it would have shown a different arbitrary subset on every scroll.
 *
 * So the cursor encodes the **whole ordering key** of the last row handed out,
 * and the predicate is a lexicographic keyset comparison over that same key.
 *
 * ## Why the id is always the last key
 *
 * A keyset cursor has to name one row unambiguously, and a sort key does not:
 * two records imported in the same millisecond share a `created_at`, and every
 * record with no capture time shares a NULL `captured_at`. Appending the
 * primary key makes the ordering total, which is what lets `>` mean "strictly
 * after this row" instead of "after every row that ties with it".
 *
 * ## Why nulls carry an explicit position
 *
 * The two backends disagree: SQLite sorts NULLs first in an ASC scan and last
 * in DESC, Postgres/DSQL does the opposite. `label-cursor.ts` escaped this by
 * making its ordering column NOT NULL; a record query cannot, because
 * `captured_at` is null for anything nobody has read EXIF from yet.
 *
 * Rather than spell `NULLS FIRST` on one side and rely on the default on the
 * other, every ordering key is emitted as the *pair* `(expr IS NULL, expr)`,
 * ordered nulls-last in both dialects whatever the key's own direction. The
 * cursor carries the null flag alongside the value so the predicate can step
 * through the null bucket, where every row ties on the key itself and only the
 * id separates them.
 *
 * ## Why the signature is checked
 *
 * A cursor means "after this row *in this order*". Handed to a query ordered
 * differently it names a position that does not exist, so it is rejected and
 * the caller gets the first page rather than a page from the middle of an order
 * it did not ask for. A caller paging normally always passes back the cursor it
 * was handed, so the check only fires on a hand-edited or stale token.
 */

import type { StarkeepId } from "@starkeep/protocol-primitives";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";

/** What an ordering key can hold once it reaches the cursor. */
export type QueryCursorValue = string | number | boolean | null;

/** One ordering key's position, as the null-normalized pair described above. */
export interface QueryCursorKey {
  /** True when the ordering expression was NULL for the row the cursor names. */
  isNull: boolean;
  /** The expression's value, and null exactly when {@link isNull} is true. */
  value: QueryCursorValue;
}

export interface QueryCursor {
  /** {@link orderSignature} of the ordering this cursor was cut against. */
  order: string;
  /** One entry per ordering key, in order. The id tiebreaker is not among them. */
  keys: QueryCursorKey[];
  /** The row's primary key: the final, total tiebreaker. */
  id: StarkeepId;
}

/** One ordering key as the query asked for it. */
export interface OrderKey {
  field: string;
  direction: "asc" | "desc";
}

/**
 * A stable name for an ordering, so a cursor can be matched to the query that
 * consumes it.
 *
 * Field names and directions only. The filters are deliberately not part of it:
 * narrowing a result set does not move a row's position within the order, so a
 * caller paging while a filter changes gets fewer rows rather than wrong ones.
 */
export function orderSignature(keys: readonly OrderKey[]): string {
  return keys.map((k) => `${k.field}:${k.direction}`).join(",");
}

export function encodeQueryCursor(cursor: QueryCursor): string {
  const payload = [cursor.order, cursor.keys.map((k) => [k.isNull ? 1 : 0, k.value]), cursor.id];
  return encodeBase64Url(JSON.stringify(payload));
}

/**
 * Returns `null` for a malformed token, or for one cut against a different
 * ordering — a caller that hand-edits an opaque cursor gets the first page,
 * not a 500 and not a page from the wrong order.
 */
export function decodeQueryCursor(token: string, order: string): QueryCursor | null {
  try {
    const json = decodeBase64Url(token);
    if (json === null) return null;
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [encodedOrder, keys, id] = parsed as [unknown, unknown, unknown];
    if (typeof encodedOrder !== "string" || encodedOrder !== order) return null;
    if (typeof id !== "string" || id.length === 0) return null;
    if (!Array.isArray(keys)) return null;

    const decoded: QueryCursorKey[] = [];
    for (const entry of keys) {
      if (!Array.isArray(entry) || entry.length !== 2) return null;
      const [flag, value] = entry as [unknown, unknown];
      if (flag !== 0 && flag !== 1) return null;
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        return null;
      }
      // A flag and a value that disagree describe no row. Rejecting is right:
      // the alternative is a predicate that compares against a value the
      // ordering says is not there.
      if ((flag === 1) !== (value === null)) return null;
      decoded.push({ isNull: flag === 1, value });
    }

    return { order, keys: decoded, id: id as StarkeepId };
  } catch {
    return null;
  }
}

/**
 * Is this ordering key pair strictly after the cursor's, ignoring later keys?
 *
 * Exists so an in-memory adapter can present the same order the SQL ones do
 * without restating the rule — the same reason `compareLabelOrder` exists.
 * Returns 0 for a tie, which the caller resolves with the next key or the id.
 */
export function compareOrderKey(
  a: QueryCursorKey,
  b: QueryCursorKey,
  direction: "asc" | "desc",
): number {
  // Nulls last in both dialects, whatever the key's direction — see the note on
  // null position above. The flag is compared ascending on purpose: `false`
  // (a value) sorts before `true` (no value).
  if (a.isNull !== b.isNull) return a.isNull ? 1 : -1;
  if (a.isNull) return 0;
  const av = a.value as string | number | boolean;
  const bv = b.value as string | number | boolean;
  if (av === bv) return 0;
  const ascending = av < bv ? -1 : 1;
  return direction === "desc" ? -ascending : ascending;
}
