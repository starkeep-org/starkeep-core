/**
 * Turning app-syncable table rows into wire entries, and refusing the ones that
 * would be interpreted as "every row".
 *
 * ## Why this is shared rather than duplicated
 *
 * Both backends' appliers (`storage-sqlite`, `storage-aurora-dsql`) built the
 * wire entry themselves, in byte-identical copies, and both copies emitted a
 * tombstone with **no `where`**. On the receiving side that degrades the
 * statement to
 *
 * ```sql
 * UPDATE <table> SET deleted_at = ?, updated_at = ? WHERE updated_at < ?
 * ```
 *
 * — no key predicate, so one deleted row soft-deletes the peer's entire table,
 * and since the wiped rows take the tombstone's `updated_at` the wipe then syncs
 * back to the node that authored the delete. It lives here now because a rule
 * about row identity is not a per-dialect concern, and because two copies of it
 * is how it stayed wrong in both.
 *
 * The types are structural on purpose. `AppSyncableRowEntry` is declared in
 * `@starkeep/sync-engine`, which depends on this package — so naming it here
 * would close a cycle. Everything below needs only the fields it names.
 */

import type { HLCTimestamp } from "@starkeep/protocol-primitives";

/** The part of an app-syncable wire entry these helpers read. */
export interface KeyedRowEntry {
  readonly timestamp: HLCTimestamp;
  readonly appId: string;
  readonly table: string;
  readonly op: "insert" | "update" | "delete";
  readonly row?: Record<string, unknown>;
  readonly where?: Record<string, unknown>;
}

/**
 * The `where` clause an update or delete must carry, or an exception.
 *
 * A keyless `UPDATE`/`DELETE` is never something a caller means: the API takes
 * `where` as a required argument, and the wire form derives it from the table's
 * primary key. An empty one is therefore always a bug upstream — a wire entry
 * built without a key, or an app posting `{"where": {}}` to
 * `/app-data/{table}` — and the cost of guessing wrong is the whole table.
 *
 * Throwing (rather than skipping) is deliberate. On the inbound sync path the
 * engine treats a failed apply as a break in that author's contiguous run, so
 * the watermark holds and the entry is offered again instead of being silently
 * dropped; on the HTTP path it surfaces to the caller. Both are better than a
 * statement that quietly matches everything.
 *
 * `pkColumns`, when the caller knows them, makes the check the *whole* key
 * rather than any key at all. A `where` naming `tenant` and not `id` on a
 * `(tenant, id)` table matches every row of that tenant — quieter than the
 * keyless case above and worse to diagnose, because the damage is bounded and
 * reads as a legitimate bulk delete. {@link keyedWhereFor} refuses to *produce*
 * such a `where`; this refuses to act on one that arrives anyway, which is the
 * same rule from the other end.
 */
export function requireKeyedWhere(
  entry: KeyedRowEntry,
  op: "update" | "delete",
  pkColumns: readonly string[] = [],
): Record<string, unknown> {
  const where = entry.where ?? {};
  if (Object.keys(where).length === 0) {
    throw new Error(
      `app-syncable ${op} for ${entry.appId}.${entry.table} carries no "where" — ` +
        `a keyless ${op} would match every row in the table and is refused`,
    );
  }
  const missing = pkColumns.filter((column) => where[column] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `app-syncable ${op} for ${entry.appId}.${entry.table} names only part of the ` +
        `primary key (missing ${missing.join(", ")}) — a partial key matches more ` +
        `rows than the one it came from and is refused`,
    );
  }
  return where;
}

/**
 * The primary-key `where` identifying one row, or null when the table has no
 * usable key for it.
 *
 * Null rather than a partial key: a `where` covering some of a composite key
 * matches more rows than the one it came from, which is the failure this module
 * exists to prevent, only quieter.
 */
export function keyedWhereFor(
  row: Record<string, unknown>,
  pkColumns: readonly string[],
): Record<string, unknown> | null {
  if (pkColumns.length === 0) return null;
  const where: Record<string, unknown> = {};
  for (const column of pkColumns) {
    const value = row[column];
    if (value === undefined) return null;
    where[column] = value;
  }
  return where;
}

/**
 * A stored row as the entry the peer will apply.
 *
 * Live rows go out as `op: "insert"` — an upsert — because the receiver may not
 * have the row yet and `op: "update"` only touches rows that already exist,
 * which would silently drop every new row during a first sync.
 *
 * Tombstones ride the soft-delete path and carry the primary key in `where`.
 * A table with no primary key (or a row missing part of one) cannot name the row
 * it is retracting, so it emits nothing at all and says so: propagating a
 * keyless tombstone is what wiped the peer's table, and propagating a partial
 * one would wipe part of it.
 */
export function rowToWireEntry(
  appId: string,
  table: string,
  row: Record<string, unknown>,
  pkColumns: readonly string[],
  deserializeTimestamp: (serialized: string) => HLCTimestamp,
): KeyedRowEntry | null {
  const updatedAt = row["updated_at"] as string;
  const deletedAt = row["deleted_at"] as string | null | undefined;
  const timestamp = deserializeTimestamp(updatedAt);

  if (!deletedAt) {
    return { timestamp, appId, table, op: "insert", row };
  }

  const where = keyedWhereFor(row, pkColumns);
  if (!where) {
    console.warn(
      `[app-syncable] cannot propagate a tombstone for ${appId}.${table}: ` +
        `the table declares no usable primary key, so the retraction has no way ` +
        `to name its row. The deletion stays local.`,
    );
    return null;
  }
  return { timestamp, appId, table, op: "delete", row, where };
}
