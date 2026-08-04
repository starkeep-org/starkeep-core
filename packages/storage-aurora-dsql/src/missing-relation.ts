/**
 * "That table isn't here" vs. "I could not read that table".
 *
 * The two arrive as the same rejected promise and mean opposite things. An app
 * that is not installed on this instance genuinely holds nothing, so answering
 * `[]`/`{}` for it is correct and is what the sync protocol expects. A table
 * that exists and will not read — a revoked GRANT, a schema mid-migration, a
 * transient data-plane error — holds an unknown number of rows, and answering
 * `[]` for *that* is how a healthy peer gets reported as having lost its
 * library.
 *
 * DSQL surfaces the Postgres SQLSTATE for these, so this reads the code rather
 * than the message: `42P01 undefined_table` and `3F000 invalid_schema_name` are
 * the two the app-syncable path can legitimately hit, because a per-app schema
 * and its tables are created together at install.
 *
 * The message fallback exists because not every client surfaces `code` — some
 * wrap the driver error — and being wrong in the "does not exist" direction
 * here costs only a re-ship, while being wrong in the other direction costs a
 * false loss report.
 */
export function isMissingRelation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? "";
  if (code === "42P01" || code === "3F000") return true;
  const message = (e?.message ?? "").toLowerCase();
  return (
    message.includes("does not exist") &&
    (message.includes("relation") || message.includes("schema"))
  );
}
