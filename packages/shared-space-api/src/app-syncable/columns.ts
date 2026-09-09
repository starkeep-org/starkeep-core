/**
 * What an app-syncable table's columns are, said once.
 *
 * Two installers create these tables — the DSQL one and the local SQLite one —
 * and both write a namespace-registry row describing what they created. The
 * registry row is what the query parser validates against, so if the two
 * installers described a table differently the same query would be legal on one
 * backend and rejected on the other. Deriving both descriptions here is the only
 * way that stays true.
 */

import type { AppSyncableColumnInfo, AppSyncableTableInfo } from "@starkeep/sync-engine";
import type { LogicalColumnType } from "@starkeep/protocol-primitives";

/**
 * Columns the sync runtime owns on every app-syncable table.
 *
 * `updated_at` is the serialized HLC every LWW comparison and every delta scan
 * reads. `node_id` is denormalized from it by the applier so the responder's
 * per-author watermark is an index seek. `deleted_at` is the tombstone.
 *
 * All three are `text` physically. `updated_at` and `deleted_at` are serialized
 * HLCs rather than timestamps, so they are deliberately **not** declared
 * `timestamp`: an HLC's leading field is hex wall time and its trailing fields
 * are a counter and a node id, which orders correctly and is not an instant.
 * Declaring it `timestamp` would invite a comparison against an ISO-8601 value
 * that would compile, run, and match nothing.
 */
export const SYSTEM_COLUMNS: readonly AppSyncableColumnInfo[] = [
  { name: "updated_at", type: "text", notNull: true, primaryKey: false },
  { name: "node_id", type: "text", notNull: true, primaryKey: false },
  { name: "deleted_at", type: "text", notNull: false, primaryKey: false },
];

/** Names of {@link SYSTEM_COLUMNS}, for the parser's rules about them. */
export const SYSTEM_COLUMN_NAMES: ReadonlySet<string> = new Set(
  SYSTEM_COLUMNS.map((c) => c.name),
);

/**
 * The soft-delete column, which no caller may name in any clause.
 *
 * The server always ANDs `deleted_at IS NULL` into a read. A caller that could
 * also name it could contradict that predicate or order by it, and either is a
 * caller reasoning about a tombstone the read path exists to hide.
 */
export const SOFT_DELETE_COLUMN = "deleted_at";

/** One column as an app's manifest declares it. */
export interface DeclaredColumn {
  readonly name: string;
  readonly type: LogicalColumnType;
  readonly notNull?: boolean;
  readonly primaryKey?: boolean;
}

/**
 * The registry description of a table, from the columns an app declared.
 *
 * The system columns are appended because the installers append them to the
 * physical table, and the registry has to describe what exists rather than what
 * was asked for — `order=updated_at.desc` is a question about a real column.
 */
export function appSyncableTableInfo(
  name: string,
  columns: readonly DeclaredColumn[],
): AppSyncableTableInfo {
  return {
    name,
    pkColumns: columns.filter((c) => c.primaryKey).map((c) => c.name),
    columns: [
      ...columns.map((c) => ({
        name: c.name,
        type: c.type,
        notNull: Boolean(c.notNull ?? c.primaryKey),
        primaryKey: Boolean(c.primaryKey),
      })),
      ...SYSTEM_COLUMNS,
    ],
  };
}

/**
 * A deterministic name for an app-declared index.
 *
 * Derived from the columns rather than declared in the manifest, because a name
 * is a second thing to keep unique and an app author has no reason to care what
 * it is. Both installers call this, so the same index carries the same name on
 * both backends and a reader comparing them is comparing like with like.
 *
 * `qualifier` is whatever makes the name unique in that engine's namespace: the
 * schema and table on DSQL, the prefixed table name on SQLite, where index
 * names are global to the database.
 *
 * Capped because Postgres truncates an identifier at 63 bytes, and two long
 * names truncating to the same thing would collide silently. The hash suffix
 * keeps them apart.
 */
export function syncableIndexName(qualifier: string, columns: readonly string[]): string {
  const full = `idx_${qualifier}_${columns.join("_")}`;
  if (full.length <= 60) return full;
  let hash = 0;
  for (const ch of full) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `${full.slice(0, 51)}_${(hash >>> 0).toString(36)}`;
}
