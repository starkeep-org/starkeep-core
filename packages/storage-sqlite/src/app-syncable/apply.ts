import type { DatabaseSync } from "node:sqlite";
import { serializeHLC, deserializeHLC } from "@starkeep/protocol-primitives";
import type { AppSyncableApplier, AppSyncableRowEntry, AppSyncableNamespaceStore, ScanCapableApplier, ScanSinceOptions, ScanSincePage } from "@starkeep/shared-space-api";
import { appSyncableTableName } from "./namespace.js";

/**
 * SQLite-backed implementation of `AppSyncableApplier`.
 *
 * All writes use the LWW (last-write-wins) rule based on the HLC-serialized
 * `updated_at` column: an incoming entry is only applied if its timestamp is
 * strictly greater than the row's current `updated_at`. This makes the applier
 * idempotent — replaying the same entry twice is a no-op.
 *
 * Delete is soft: the `deleted_at` column is set rather than removing the row
 * so that the inline-HLC pull path can propagate tombstones to other clients.
 */
export class SqliteAppSyncableApplier
  implements AppSyncableApplier, ScanCapableApplier
{
  constructor(
    private readonly db: DatabaseSync,
    private readonly namespace: AppSyncableNamespaceStore,
  ) {}

  apply(entry: AppSyncableRowEntry): void {
    const ns = this.namespace.get(entry.appId);
    if (!ns) {
      throw new Error(
        `SqliteAppSyncableApplier: app "${entry.appId}" not installed`,
      );
    }
    const tableInfo = ns.tables.find((t) => t.name === entry.table);
    if (!tableInfo) {
      throw new Error(
        `SqliteAppSyncableApplier: table "${entry.table}" not declared for app "${entry.appId}"`,
      );
    }

    const fullName = appSyncableTableName(entry.appId, entry.table);
    const { pkColumns } = tableInfo;

    if (entry.op === "insert") {
      this.applyInsert(fullName, pkColumns, entry);
    } else if (entry.op === "update") {
      this.applyUpdate(fullName, entry);
    } else {
      this.applyDelete(fullName, entry);
    }
  }

  private applyInsert(
    fullName: string,
    pkColumns: string[],
    entry: AppSyncableRowEntry,
  ): void {
    const row = entry.row ?? {};
    const cols = Object.keys(row);
    if (cols.length === 0) return;

    const colList = cols.map(q).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((c) => row[c] as unknown);

    if (pkColumns.length === 0) {
      // No PK declared — just insert, ignoring duplicates.
      this.db
        .prepare(`INSERT OR IGNORE INTO ${q(fullName)} (${colList}) VALUES (${placeholders})`)
        .run(...(values as never[]));
      return;
    }

    // UPSERT with LWW: only overwrite if the incoming updated_at is newer.
    const conflictTarget = pkColumns.map(q).join(", ");
    const updateCols = cols.filter((c) => !pkColumns.includes(c));
    if (updateCols.length === 0) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ${q(fullName)} (${colList}) VALUES (${placeholders})`,
        )
        .run(...(values as never[]));
      return;
    }
    const setClause = updateCols.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ");
    this.db
      .prepare(
        `INSERT INTO ${q(fullName)} (${colList}) VALUES (${placeholders})
         ON CONFLICT(${conflictTarget}) DO UPDATE SET ${setClause}
         WHERE excluded.updated_at > ${q(fullName)}.updated_at`,
      )
      .run(...(values as never[]));
  }

  private applyUpdate(fullName: string, entry: AppSyncableRowEntry): void {
    const patch = entry.row ?? {};
    const where = entry.where ?? {};
    const patchCols = Object.keys(patch);
    const whereCols = Object.keys(where);
    if (patchCols.length === 0) return;

    const setClause = patchCols.map((c) => `${q(c)} = ?`).join(", ");
    // Only apply if the incoming updated_at is strictly newer (LWW).
    const incomingUpdatedAt = patch["updated_at"] as string | undefined;
    const conditions: string[] = whereCols.map((c) => `${q(c)} = ?`);
    if (incomingUpdatedAt) conditions.push(`updated_at < ?`);
    const whereClause = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    const params: unknown[] = [
      ...patchCols.map((c) => patch[c]),
      ...whereCols.map((c) => where[c]),
    ];
    if (incomingUpdatedAt) params.push(incomingUpdatedAt);

    this.db
      .prepare(`UPDATE ${q(fullName)} SET ${setClause}${whereClause}`)
      .run(...(params as never[]));
  }

  private applyDelete(fullName: string, entry: AppSyncableRowEntry): void {
    const where = entry.where ?? {};
    const whereCols = Object.keys(where);
    // Soft-delete: set deleted_at and updated_at.
    const incomingUpdatedAt = entry.row?.["updated_at"] as string | undefined;
    const ts = incomingUpdatedAt ?? serializeHLC(entry.timestamp);

    const conditions: string[] = [
      ...whereCols.map((c) => `${q(c)} = ?`),
      `(updated_at IS NULL OR updated_at < ?)`,
    ];
    const whereClause = " WHERE " + conditions.join(" AND ");

    // params order: SET deleted_at=?, updated_at=?, then WHERE bindings
    const params: unknown[] = [
      ts,
      ts,
      ...whereCols.map((c) => where[c]),
      ts,  // for the LWW updated_at < ? condition
    ];

    this.db
      .prepare(
        `UPDATE ${q(fullName)} SET deleted_at = ?, updated_at = ?${whereClause}`,
      )
      .run(...(params as never[]));
  }

  /**
   * Pull-side synthesis: return rows updated after `sinceHlcStr` (or `cursor`
   * if higher) in HLC order, paginated. `updated_at` is a serialized HLC
   * whose lexicographic order matches HLC order (fixed-width hex), and each
   * row's HLC is unique per node, so it doubles as the cursor — no separate
   * tiebreaker column is needed.
   */
  async scanSince(
    appId: string,
    table: string,
    sinceHlcStr: string,
    options?: ScanSinceOptions,
  ): Promise<ScanSincePage> {
    const fullName = appSyncableTableName(appId, table);
    const floor =
      options?.cursor !== undefined && options.cursor > sinceHlcStr
        ? options.cursor
        : sinceHlcStr;
    const limit = options?.limit;
    let rows: Record<string, unknown>[];
    try {
      if (limit !== undefined) {
        rows = this.db
          .prepare(
            `SELECT * FROM ${q(fullName)} WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ?`,
          )
          .all(floor, limit + 1) as Record<string, unknown>[];
      } else {
        rows = this.db
          .prepare(
            `SELECT * FROM ${q(fullName)} WHERE updated_at > ? ORDER BY updated_at ASC`,
          )
          .all(floor) as Record<string, unknown>[];
      }
    } catch {
      // Table might not exist yet (app not installed locally).
      return { rows: [], nextCursor: null, hasMore: false };
    }
    const hasMore = limit !== undefined && rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const entries = pageRows.map((row) => rowToEntry(appId, table, row));
    const nextCursor =
      hasMore && pageRows.length > 0
        ? (pageRows[pageRows.length - 1]!["updated_at"] as string)
        : null;
    return { rows: entries, nextCursor, hasMore };
  }

  /** Support read path from the factory's queryRows. */
  queryRows(
    appId: string,
    table: string,
    where?: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const fullName = appSyncableTableName(appId, table);
    const whereCols = where ? Object.keys(where) : [];
    // Filter out soft-deleted rows by default.
    const whereClause = [
      "deleted_at IS NULL",
      ...whereCols.map((c) => `${q(c)} = ?`),
    ].join(" AND ");
    return this.db
      .prepare(`SELECT * FROM ${q(fullName)} WHERE ${whereClause}`)
      .all(...(whereCols.map((c) => where![c]) as never[])) as Record<string, unknown>[];
  }
}

function q(name: string): string {
  return `"${name}"`;
}

function rowToEntry(
  appId: string,
  table: string,
  row: Record<string, unknown>,
): AppSyncableRowEntry {
  const updatedAtStr = row["updated_at"] as string;
  const deletedAtStr = row["deleted_at"] as string | null | undefined;
  const timestamp = deserializeHLC(updatedAtStr);

  // For wire propagation we emit op="insert" (upsert) for live rows so the
  // receiver creates the row if it doesn't exist yet. op="update" only
  // targets existing rows and would silently drop new rows during initial
  // sync. Tombstones still ride the soft-delete path.
  if (deletedAtStr) {
    return { timestamp, appId, table, op: "delete", row };
  }
  return { timestamp, appId, table, op: "insert", row };
}
