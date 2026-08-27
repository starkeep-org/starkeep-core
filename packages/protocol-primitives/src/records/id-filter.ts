/** Maximum distinct records addressable by one bounded list lookup. */
export const MAX_RECORD_ID_FILTER = 100;

export type ParsedRecordIdFilter =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

/**
 * Parse the `ids` query parameter used by record-scoped batch reads.
 *
 * The result is deduplicated and sorted so response order and query shape do
 * not depend on the caller's input order. Empty members are rejected instead
 * of silently widening the lookup.
 */
export function parseRecordIdFilter(raw: string): ParsedRecordIdFilter {
  if (raw.length === 0) {
    return { ok: false, message: "ids must list at least one record ID" };
  }
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return { ok: false, message: "ids must not contain empty record IDs" };
  }
  if (parts.some((part) => part.length > 128 || !/^[A-Za-z0-9._:@-]+$/.test(part))) {
    return { ok: false, message: "ids contains a malformed record ID" };
  }
  const ids = [...new Set(parts)].sort();
  if (ids.length > MAX_RECORD_ID_FILTER) {
    return {
      ok: false,
      message: `ids accepts at most ${MAX_RECORD_ID_FILTER} distinct record IDs (got ${ids.length})`,
    };
  }
  return { ok: true, ids };
}
