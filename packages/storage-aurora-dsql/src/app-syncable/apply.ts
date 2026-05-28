import { serializeHLC, deserializeHLC } from "@starkeep/core";
import type {
  AppSyncableApplier,
  AppSyncableRowEntry,
  AppSyncableNamespaceStore,
  ScanCapableApplier,
  FileRecordRow,
  FileRecordsApplier,
} from "@starkeep/shared-space-api";
import { FILE_RECORDS_TABLE } from "@starkeep/shared-space-api";
import type { DatabaseClient } from "../types.js";

/**
 * DSQL-backed implementation of `AppSyncableApplier`.
 *
 * Tables live in `app_<appId>.<table>` (using the app's private PG schema).
 * All writes use LWW based on the HLC-serialized `updated_at` column.
 * Deletes are soft: `deleted_at` and `updated_at` are set rather than removing
 * the row so that tombstones propagate to other clients via pull.
 */
export class DsqlAppSyncableApplier
  implements AppSyncableApplier, ScanCapableApplier, FileRecordsApplier
{
  constructor(
    private readonly client: DatabaseClient,
    private readonly namespace: AppSyncableNamespaceStore,
  ) {}

  async apply(entry: AppSyncableRowEntry): Promise<void> {
    const ns = this.namespace.get(entry.appId);
    if (!ns) {
      throw new Error(
        `DsqlAppSyncableApplier: app "${entry.appId}" not installed on this instance`,
      );
    }
    const tableInfo = ns.tables.find((t) => t.name === entry.table);
    if (!tableInfo) {
      throw new Error(
        `DsqlAppSyncableApplier: table "${entry.table}" not declared for app "${entry.appId}"`,
      );
    }

    const schemaTable = `app_${entry.appId.replace(/-/g, "_")}."${entry.table}"`;
    const { pkColumns } = tableInfo;

    if (entry.op === "insert") {
      await this.applyInsert(schemaTable, pkColumns, entry);
    } else if (entry.op === "update") {
      await this.applyUpdate(schemaTable, entry);
    } else {
      await this.applyDelete(schemaTable, entry);
    }
  }

  private async applyInsert(
    schemaTable: string,
    pkColumns: string[],
    entry: AppSyncableRowEntry,
  ): Promise<void> {
    const row = entry.row ?? {};
    const cols = Object.keys(row);
    if (cols.length === 0) return;

    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const values = cols.map((c) => row[c]);

    if (pkColumns.length === 0) {
      await this.client.query(
        `INSERT INTO ${schemaTable} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values,
      );
      return;
    }

    const conflictTarget = pkColumns.map((c) => `"${c}"`).join(", ");
    const updateCols = cols.filter((c) => !pkColumns.includes(c));
    if (updateCols.length === 0) {
      await this.client.query(
        `INSERT INTO ${schemaTable} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflictTarget}) DO NOTHING`,
        values,
      );
      return;
    }

    const setClause = updateCols
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(", ");
    await this.client.query(
      `INSERT INTO ${schemaTable} (${colList}) VALUES (${placeholders})
       ON CONFLICT (${conflictTarget}) DO UPDATE SET ${setClause}
       WHERE EXCLUDED.updated_at > ${schemaTable}.updated_at`,
      values,
    );
  }

  private async applyUpdate(
    schemaTable: string,
    entry: AppSyncableRowEntry,
  ): Promise<void> {
    const patch = entry.row ?? {};
    const where = entry.where ?? {};
    const patchCols = Object.keys(patch);
    const whereCols = Object.keys(where);
    if (patchCols.length === 0) return;

    let paramIdx = 1;
    const setClause = patchCols.map((c) => `"${c}" = $${paramIdx++}`).join(", ");
    const conditions = whereCols.map((c) => `"${c}" = $${paramIdx++}`);
    const incomingUpdatedAt = patch["updated_at"] as string | undefined;
    if (incomingUpdatedAt) conditions.push(`updated_at < $${paramIdx++}`);
    const whereClause = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    const params: unknown[] = [
      ...patchCols.map((c) => patch[c]),
      ...whereCols.map((c) => where[c]),
    ];
    if (incomingUpdatedAt) params.push(incomingUpdatedAt);

    await this.client.query(
      `UPDATE ${schemaTable} SET ${setClause}${whereClause}`,
      params,
    );
  }

  private async applyDelete(
    schemaTable: string,
    entry: AppSyncableRowEntry,
  ): Promise<void> {
    const where = entry.where ?? {};
    const whereCols = Object.keys(where);
    const ts = entry.row?.["updated_at"] as string ?? serializeHLC(entry.timestamp);

    let paramIdx = 1;
    const tsIdx1 = paramIdx++;
    const tsIdx2 = paramIdx++;
    const conditions = whereCols.map((c) => `"${c}" = $${paramIdx++}`);
    conditions.push(`(updated_at IS NULL OR updated_at < $${paramIdx++})`);
    const whereClause = " WHERE " + conditions.join(" AND ");

    const params: unknown[] = [
      ts, ts,
      ...whereCols.map((c) => where[c]),
      ts,
    ];

    await this.client.query(
      `UPDATE ${schemaTable} SET deleted_at = $${tsIdx1}, updated_at = $${tsIdx2}${whereClause}`,
      params,
    );
  }

  /** Scan rows updated after `sinceHlcStr` for pull synthesis. */
  async scanSince(
    appId: string,
    table: string,
    sinceHlcStr: string,
  ): Promise<AppSyncableRowEntry[]> {
    const schemaTable = `app_${appId.replace(/-/g, "_")}."${table}"`;
    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.client.query(
        `SELECT * FROM ${schemaTable} WHERE updated_at > $1`,
        [sinceHlcStr],
      );
    } catch {
      return [];
    }
    return result.rows.map((row) => rowToEntry(appId, table, row));
  }

  /**
   * Scan the reserved `_starkeep_sync_records` table for rows in the given
   * sync_status set. Excludes soft-deleted rows. Returns an empty array if
   * the app's schema doesn't have a reserved table yet.
   */
  async scanFileRecordsByStatus(
    appId: string,
    statuses: string[],
  ): Promise<FileRecordRow[]> {
    if (statuses.length === 0) return [];
    const schemaTable = `app_${appId.replace(/-/g, "_")}."${FILE_RECORDS_TABLE}"`;
    const placeholders = statuses.map((_, i) => `$${i + 1}`).join(", ");
    try {
      const result = await this.client.query(
        `SELECT * FROM ${schemaTable}
         WHERE deleted_at IS NULL AND sync_status IN (${placeholders})`,
        statuses,
      );
      return result.rows.map(rowToFileRecord);
    } catch {
      return [];
    }
  }

  /**
   * Local-only sync_status update that intentionally does not touch
   * `updated_at`. See FileRecordsApplier for the why.
   */
  async setFileRecordStatus(
    appId: string,
    id: string,
    status: string,
  ): Promise<void> {
    const schemaTable = `app_${appId.replace(/-/g, "_")}."${FILE_RECORDS_TABLE}"`;
    await this.client.query(
      `UPDATE ${schemaTable} SET sync_status = $1 WHERE id = $2`,
      [status, id],
    );
  }

  /** Support read path from the factory's queryRows. */
  async queryRows(
    appId: string,
    table: string,
    where?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const schemaTable = `app_${appId.replace(/-/g, "_")}."${table}"`;
    const whereCols = where ? Object.keys(where) : [];
    const conditions = ["deleted_at IS NULL", ...whereCols.map((c, i) => `"${c}" = $${i + 1}`)];
    const result = await this.client.query(
      `SELECT * FROM ${schemaTable} WHERE ${conditions.join(" AND ")}`,
      whereCols.map((c) => where![c]),
    );
    return result.rows;
  }
}

function rowToFileRecord(row: Record<string, unknown>): FileRecordRow {
  return {
    id: row["id"] as string,
    sync_status: row["sync_status"] as string,
    object_storage_key: row["object_storage_key"] as string,
    content_hash: row["content_hash"] as string,
    mime_type: row["mime_type"] as string,
    size_bytes: Number(row["size_bytes"]),
    original_filename: (row["original_filename"] as string | null) ?? null,
    origin_app_id: row["origin_app_id"] as string,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    deleted_at: (row["deleted_at"] as string | null) ?? null,
  };
}

function rowToEntry(
  appId: string,
  table: string,
  row: Record<string, unknown>,
): AppSyncableRowEntry {
  const updatedAtStr = row["updated_at"] as string;
  const deletedAtStr = row["deleted_at"] as string | null | undefined;
  const timestamp = deserializeHLC(updatedAtStr);

  // Upsert-on-wire: receivers may not yet have this row, so emit op="insert"
  // for live rows and let the applier's INSERT … ON CONFLICT path do the
  // right thing in both directions.
  if (deletedAtStr) {
    return { timestamp, appId, table, op: "delete", row };
  }
  return { timestamp, appId, table, op: "insert", row };
}
