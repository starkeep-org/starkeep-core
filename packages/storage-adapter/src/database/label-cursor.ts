/**
 * The label **scan** cursor, for the sync outbound scan.
 *
 * Ordered by the primary key `(record_id, app_id, key, value)` rather than by
 * the reverse index, and it includes tombstones, because sync ships retractions
 * like any other row.
 *
 * ## Why the reverse query's cursor is not here
 *
 * `findByLabel` used to carry its own composite `(value, record_id)` token
 * beside this one, and conflating them would have produced a token that meant
 * one thing to each. The reverse query is a parsed query now and pages with the
 * grammar's `page_token` — see `label-find.ts` — so only the scan cursor is
 * left, and the risk of confusing the two is gone rather than documented.
 */

import type { StarkeepId } from "@starkeep/protocol-primitives";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";

/** Cursor for the sync-side scan over *all* label rows, tombstones included. */
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
  return encodeBase64Url(JSON.stringify([c.recordId, c.appId, c.key, c.value]));
}

export function decodeLabelScanCursor(token: string): LabelScanCursor | null {
  try {
    const json = decodeBase64Url(token);
    if (json === null) return null;
    const parsed = JSON.parse(json) as unknown;
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

/** Is this row strictly after the cursor, in {@link compareLabelScanOrder}? */
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
