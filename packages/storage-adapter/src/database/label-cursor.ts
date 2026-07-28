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
 * ## `value` is NOT NULL, which is what makes this simple
 *
 * `value` used to be nullable (a bare flag), and the two backends disagree about
 * where nulls sort: SQLite puts them first in an ASC scan, Postgres/DSQL puts
 * them last. That forced both adapters to normalize on nulls-first — spelled out
 * as `NULLS FIRST` on the Postgres side — or the same cursor would have meant
 * different things against a local and a cloud data-server, skipping rows on one
 * of them.
 *
 * With `value` NOT NULL (a bare flag is `""`, which sorts first naturally on
 * both) that whole divergence is gone rather than papered over, and a plain
 * row-value comparison `(value, record_id) > (?, ?)` is usable — it was not
 * before, because a NULL on either side evaluates to NULL rather than true or
 * false, silently returning an empty page instead of erroring.
 */

import type { StarkeepId } from "@starkeep/protocol-primitives";

export interface LabelCursor {
  /** `""` for a bare flag; never null — see the note above. */
  value: string;
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
    if (typeof value !== "string") return null;
    if (typeof recordId !== "string" || recordId.length === 0) return null;
    return { value, recordId: recordId as StarkeepId };
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
  /**
   * The fourth primary-key column. Without it the scan cursor is not unique:
   * two values of one key share `(record, app, key)`, so `> cursor` would skip
   * every sibling value after the first — losing label rows from the sync
   * stream silently, since a short page is not an error.
   */
  value: string;
}

export function encodeLabelScanCursor(c: LabelScanCursor): string {
  return Buffer.from(JSON.stringify([c.recordId, c.appId, c.key, c.value]), "utf8").toString(
    "base64url",
  );
}

export function decodeLabelScanCursor(token: string): LabelScanCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [recordId, appId, key, value] = parsed as [unknown, unknown, unknown, unknown];
    if (
      typeof recordId !== "string" ||
      typeof appId !== "string" ||
      typeof key !== "string" ||
      typeof value !== "string"
    ) {
      return null;
    }
    return { recordId: recordId as StarkeepId, appId, key, value };
  } catch {
    return null;
  }
}

/**
 * The SQL form of the predicate is built once, in label-queries.ts, with the
 * calling adapter's Kysely expression builder — so parameter binding stays the
 * compiler's job. With `value` NOT NULL it is a single case, and the same one
 * the comparator below spells:
 *
 *   `value > ? OR (value = ? AND record_id > ?)`
 */

/** The part of a label the reverse-index order is defined over. */
interface OrderedLabel {
  value: string;
  recordId: StarkeepId;
}

/**
 * The reverse index's order as a comparator: value ascending, then record id.
 *
 * Exists so an in-memory adapter can present the same order the SQL ones do
 * without restating the rule.
 */
export function compareLabelOrder(a: OrderedLabel, b: OrderedLabel): number {
  if (a.value !== b.value) return a.value < b.value ? -1 : 1;
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
  if (label.key !== cursor.key) return label.key > cursor.key;
  return label.value > cursor.value;
}

/** Primary-key order, for an in-memory scan. */
export function compareLabelScanOrder(a: LabelScanCursor, b: LabelScanCursor): number {
  if (a.recordId !== b.recordId) return a.recordId < b.recordId ? -1 : 1;
  if (a.appId !== b.appId) return a.appId < b.appId ? -1 : 1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.value !== b.value) return a.value < b.value ? -1 : 1;
  return 0;
}
