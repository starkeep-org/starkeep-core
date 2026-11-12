import type { RowWriteResult } from "../types.js";

/** One row route's answer: an HTTP status and its JSON body. */
export interface RowWriteResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * The HTTP answer for one row write. Both data servers hand-write their row
 * routes, so the status mapping lives here once and the two cannot drift.
 *
 * - `POST`: 200, except as below. A skipped `ifAbsent` insert is an expected
 *   outcome, so the body carries `changes: 0` and `skipped: "live" | "deleted"`.
 * - `PATCH`: 404 when no live row holds the key. A deleted row answers exactly
 *   as a missing one does. 409 when the row's stamp no longer matches.
 * - `DELETE`: 200 with `changes: 0` and `skipped: "deleted"` for a row already
 *   deleted, so a retried delete succeeds. 404 for a key no row ever held. 409
 *   when the row's stamp no longer matches.
 * - All three: 409 with `skipped: "superseded"` when the row carries a newer
 *   stamp than the write, so last-writer-wins kept the row as it was.
 */
export function rowWriteResponse(
  method: "POST" | "PATCH" | "DELETE",
  result: RowWriteResult,
): RowWriteResponse {
  const { changes, skipped } = result;
  if (skipped === "superseded") {
    return {
      status: 409,
      body: {
        error: "A newer write to the row won, so this write changed nothing",
        changes,
        skipped,
      },
    };
  }
  if (method === "POST") {
    return {
      status: 200,
      body: skipped === undefined ? { ok: true, changes } : { ok: true, changes, skipped },
    };
  }
  if (skipped === undefined) return { status: 200, body: { changes } };
  if (skipped === "stale") {
    return {
      status: 409,
      body: { error: "The row changed since the stamp the write named", changes, skipped },
    };
  }
  if (method === "DELETE" && skipped === "deleted") {
    return { status: 200, body: { changes, skipped } };
  }
  return { status: 404, body: { error: "No live row holds that key", changes } };
}
