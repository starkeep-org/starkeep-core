/**
 * The `findByLabel` pagination cursor.
 *
 * The cursor encodes the composite **`(value, record_id)`** — the reverse
 * index's own residual order once `app_id`, `key` and `deleted_at` are pinned —
 * and not a bare record id. A bare id is only correct when `value` is pinned or
 * uniformly null; on a value-less query against a key carrying varied values,
 * `record_id` is not monotonic across the range, so `record_id > cursor` would
 * silently skip and repeat rows. Encoding the index's order is correct in every
 * case and collapses to plain id order whenever value is pinned or uniformly
 * null.
 *
 * It is opaque to callers, which is what lets it be a composite at no cost to
 * the API surface.
 *
 * ## Null ordering is normalized to NULLS FIRST
 *
 * `value` is nullable (a bare flag), and the two backends disagree about where
 * nulls sort: SQLite puts them first in an ASC scan, Postgres/DSQL puts them
 * last. Left alone, the same cursor would mean different things on a local and
 * a cloud data-server, and a query paging across the null/non-null boundary
 * would skip rows on one of them.
 *
 * So both adapters sort **nulls first** — SQLite's natural order, spelled
 * explicitly as `NULLS FIRST` on the Postgres side. This costs nothing on DSQL,
 * which sorts the index-scan output regardless (visible as a `Sort` node above
 * the `Index Only Scan` in the §3b plans).
 *
 * A row-value comparison (`(value, record_id) > (?, ?)`) is *not* usable here
 * for the same reason: with a NULL on either side it evaluates to NULL rather
 * than true or false, which silently returns an empty page instead of erroring.
 * {@link labelCursorPredicate} expands it instead.
 */

import type { StarkeepId } from "@starkeep/protocol-primitives";

export interface LabelCursor {
  /** `null` for a bare flag — see the null-ordering note above. */
  value: string | null;
  recordId: StarkeepId;
}

export function encodeLabelCursor(cursor: LabelCursor): string {
  return Buffer.from(JSON.stringify([cursor.value, cursor.recordId]), "utf8").toString(
    "base64url",
  );
}

/** Returns `null` for a malformed token rather than throwing: a caller that
 *  hand-edits an opaque cursor gets the first page, not a 500. */
export function decodeLabelCursor(token: string): LabelCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [value, recordId] = parsed as [unknown, unknown];
    if (value !== null && typeof value !== "string") return null;
    if (typeof recordId !== "string" || recordId.length === 0) return null;
    return { value: value as string | null, recordId: recordId as StarkeepId };
  } catch {
    return null;
  }
}

/**
 * Cursor for the sync-side scan over *all* label rows, which is ordered by the
 * primary key rather than by the reverse index. Separate from
 * {@link LabelCursor} because it keys on a different order and includes
 * tombstones; conflating them would produce a token that means one thing to
 * `findByLabel` and another to `queryLabels`.
 */
export interface LabelScanCursor {
  recordId: StarkeepId;
  appId: string;
  key: string;
}

export function encodeLabelScanCursor(c: LabelScanCursor): string {
  return Buffer.from(JSON.stringify([c.recordId, c.appId, c.key]), "utf8").toString(
    "base64url",
  );
}

export function decodeLabelScanCursor(token: string): LabelScanCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [recordId, appId, key] = parsed as [unknown, unknown, unknown];
    if (typeof recordId !== "string" || typeof appId !== "string" || typeof key !== "string") {
      return null;
    }
    return { recordId: recordId as StarkeepId, appId, key };
  } catch {
    return null;
  }
}

/**
 * The predicate itself is built with each adapter's Kysely expression builder
 * rather than shared as a SQL string, so parameter binding stays the compiler's
 * job. Both spell the same two cases:
 *
 *   cursor value IS NULL → `value IS NOT NULL OR (value IS NULL AND id > ?)`
 *   otherwise            → `value > ? OR (value = ? AND id > ?)`
 *
 * The second case needs no null branch: nulls sort first, so none can follow a
 * non-null cursor.
 */
