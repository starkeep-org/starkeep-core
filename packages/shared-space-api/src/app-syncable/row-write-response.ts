import type { RowWriteResult } from "../types.js";

/** The write conditions each row route takes. */
const ROUTE_CONDITIONS = {
  POST: ["ifAbsent"],
  PATCH: ["ifUpdatedAt"],
  DELETE: ["ifUpdatedAt"],
} as const;

const ALL_CONDITIONS = ["ifAbsent", "ifUpdatedAt"] as const;

/**
 * Refuse a write condition that the route does not take. Both data servers
 * answer the thrown error with 400.
 *
 * A route that dropped the condition would run the write unguarded and answer
 * as if the guard held. An `ifUpdatedAt` sent with a `POST` would upsert over
 * any change since the read. The factory refuses a condition of the wrong type
 * for the same reason.
 */
export function refuseMisplacedConditions(
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
): void {
  if (typeof body !== "object" || body === null) return;
  const taken: readonly string[] = ROUTE_CONDITIONS[method];
  for (const condition of ALL_CONDITIONS) {
    if (taken.includes(condition)) continue;
    if ((body as Record<string, unknown>)[condition] === undefined) continue;
    throw new Error(`${method} does not take ${condition}. It takes ${taken.join(" and ")} only.`);
  }
}

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
 * - `PATCH`: 404 with `skipped: "missing"` when no live row holds the key. A
 *   deleted row answers exactly as a missing one does. 409 when the row's
 *   stamp no longer matches.
 * - `DELETE`: 200 with `changes: 0` and `skipped: "deleted"` for a row already
 *   deleted, so a retried delete succeeds. 404 with `skipped: "missing"` for a
 *   key no row ever held. 409 when the row's stamp no longer matches.
 * - Every row 404 carries `skipped: "missing"`. The route's other 404s, such as
 *   an app with no app-syncable namespace, carry no `skipped`, so a client can
 *   tell "no row" from "no route".
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
  // A deleted row reports `missing` here too, so a PATCH of one answers exactly
  // as a PATCH of a key no row ever held.
  return {
    status: 404,
    body: { error: "No live row holds that key", changes, skipped: "missing" },
  };
}
