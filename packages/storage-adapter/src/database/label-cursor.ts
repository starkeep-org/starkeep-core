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
 * The SQL form of the predicate is built once, in label-queries.ts, with the
 * calling adapter's Kysely expression builder — so parameter binding stays the
 * compiler's job. It spells the same two cases the comparators below do:
 *
 *   cursor value IS NULL → `value IS NOT NULL OR (value IS NULL AND id > ?)`
 *   otherwise            → `value > ? OR (value = ? AND id > ?)`
 *
 * The second case needs no null branch: nulls sort first, so none can follow a
 * non-null cursor.
 */

/** The part of a label the reverse-index order is defined over. */
interface OrderedLabel {
  value: string | null;
  recordId: StarkeepId;
}

/**
 * The reverse index's order as a comparator: nulls first, then value ascending,
 * then record id.
 *
 * Exists so an in-memory adapter can present the same order the SQL ones do
 * without restating the rule. A memory adapter that sorted nulls *last* — the
 * Postgres default, and an easy thing to write by accident — would page
 * correctly in its own tests and disagree with both real backends.
 */
export function compareLabelOrder(a: OrderedLabel, b: OrderedLabel): number {
  if (a.value === null && b.value !== null) return -1;
  if (a.value !== null && b.value === null) return 1;
  if (a.value !== null && b.value !== null && a.value !== b.value) {
    return a.value < b.value ? -1 : 1;
  }
  return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
}

/** Is this label strictly after the cursor, in {@link compareLabelOrder}? */
export function isAfterLabelCursor(label: OrderedLabel, cursor: LabelCursor): boolean {
  return compareLabelOrder(label, cursor) > 0;
}

/** The same, for the primary-key order the sync scan uses. */
export function isAfterLabelScanCursor(
  label: LabelScanCursor,
  cursor: LabelScanCursor,
): boolean {
  if (label.recordId !== cursor.recordId) return label.recordId > cursor.recordId;
  if (label.appId !== cursor.appId) return label.appId > cursor.appId;
  return label.key > cursor.key;
}

/** Primary-key order, for an in-memory scan. */
export function compareLabelScanOrder(a: LabelScanCursor, b: LabelScanCursor): number {
  if (a.recordId !== b.recordId) return a.recordId < b.recordId ? -1 : 1;
  if (a.appId !== b.appId) return a.appId < b.appId ? -1 : 1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return 0;
}
