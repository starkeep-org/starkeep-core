import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC } from "@starkeep/protocol-primitives";
import type {
  AppSyncableApplier,
  AppSyncableRowEntry,
  AppSyncableNamespaceStore,
  ScanCapableApplier,
  ScanSinceOptions,
  ScanSincePage,
} from "@starkeep/shared-space-api";
import type { DatabaseClient } from "../types.js";
import { withOccRetry } from "../occ-retry.js";

/**
 * DSQL-backed implementation of `AppSyncableApplier`.
 *
 * Tables live in `app_<appId>.<table>` (using the app's private PG schema).
 * All writes use LWW based on the HLC-serialized `updated_at` column.
 * Deletes are soft: `deleted_at` and `updated_at` are set rather than removing
 * the row so that tombstones propagate to other clients via pull.
 */
export class DsqlAppSyncableApplier
  implements AppSyncableApplier, ScanCapableApplier
{
  constructor(
    private readonly client: DatabaseClient,
    private readonly namespace: AppSyncableNamespaceStore,
  ) {}

  // Each branch is a single LWW-guarded statement (upsert / conditional
  // update / soft-delete keyed on `updated_at`), so replaying the whole
  // dispatch on an OCC conflict is idempotent.
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

    await withOccRetry(`applier.apply(${entry.op})`, async () => {
      if (entry.op === "insert") {
        await this.applyInsert(schemaTable, pkColumns, entry);
      } else if (entry.op === "update") {
        await this.applyUpdate(schemaTable, entry);
      } else {
        await this.applyDelete(schemaTable, entry);
      }
    });
  }

  private async applyInsert(
    schemaTable: string,
    pkColumns: string[],
    entry: AppSyncableRowEntry,
  ): Promise<void> {
    const row = withNodeId(entry.row ?? {}, entry);
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
    // node_id rides along whenever updated_at changes (it's derived from it).
    const rawPatch = entry.row ?? {};
    const patch = rawPatch["updated_at"] ? withNodeId(rawPatch, entry) : rawPatch;
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
    const nodeIdx = paramIdx++;
    const conditions = whereCols.map((c) => `"${c}" = $${paramIdx++}`);
    conditions.push(`(updated_at IS NULL OR updated_at < $${paramIdx++})`);
    const whereClause = " WHERE " + conditions.join(" AND ");

    const params: unknown[] = [
      ts, ts,
      nodeIdOf(ts, entry),
      ...whereCols.map((c) => where[c]),
      ts,
    ];

    await this.client.query(
      `UPDATE ${schemaTable} SET deleted_at = $${tsIdx1}, updated_at = $${tsIdx2}, node_id = $${nodeIdx}${whereClause}`,
      params,
    );
  }

  /**
   * Scan rows updated after `sinceHlcStr` (or `cursor` if higher) in HLC
   * order, paginated. `updated_at` is a serialized HLC whose lexicographic
   * order matches HLC order, and each row's HLC is unique per node, so it
   * doubles as the cursor — no separate tiebreaker column is needed.
   */
  async scanSince(
    appId: string,
    table: string,
    sinceHlcStr: string,
    options?: ScanSinceOptions,
  ): Promise<ScanSincePage> {
    const schemaTable = `app_${appId.replace(/-/g, "_")}."${table}"`;
    const floor =
      options?.cursor !== undefined && options.cursor > sinceHlcStr
        ? options.cursor
        : sinceHlcStr;
    const limit = options?.limit;
    let result: { rows: Record<string, unknown>[] };
    try {
      if (limit !== undefined) {
        result = await this.client.query(
          `SELECT * FROM ${schemaTable} WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT $2`,
          [floor, limit + 1],
        );
      } else {
        result = await this.client.query(
          `SELECT * FROM ${schemaTable} WHERE updated_at > $1 ORDER BY updated_at ASC`,
          [floor],
        );
      }
    } catch {
      return { rows: [], nextCursor: null, hasMore: false };
    }
    const hasMore = limit !== undefined && result.rows.length > limit;
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const entries = pageRows.map((row) => rowToEntry(appId, table, row));
    const nextCursor =
      hasMore && pageRows.length > 0
        ? (pageRows[pageRows.length - 1]!["updated_at"] as string)
        : null;
    return { rows: entries, nextCursor, hasMore };
  }

  /** See `ScanCapableApplier.getNodeWatermarks`. Missing table → `{}`. */
  async getNodeWatermarks(
    appId: string,
    table: string,
  ): Promise<Record<string, HLCTimestamp>> {
    const schemaTable = `app_${appId.replace(/-/g, "_")}."${table}"`;
    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.client.query(
        `SELECT node_id, MAX(updated_at) AS max_updated_at FROM ${schemaTable} GROUP BY node_id`,
        [],
      );
    } catch {
      // Table might not exist (app not installed) or not be readable by this
      // channel's role. Omitting its nodes only understates the coverage
      // watermark, which is the safe direction (re-ship, idempotent LWW).
      return {};
    }
    const out: Record<string, HLCTimestamp> = {};
    for (const row of result.rows) {
      out[row["node_id"] as string] = deserializeHLC(row["max_updated_at"] as string);
    }
    return out;
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

/**
 * Return `row` with `node_id` set from its `updated_at` (falling back to the
 * entry timestamp). Writers can't be trusted to carry the column — locally
 * authored entries and older wire rows don't — so the applier derives it at
 * write time, keeping the NOT NULL invariant without touching every producer.
 */
function withNodeId(
  row: Record<string, unknown>,
  entry: AppSyncableRowEntry,
): Record<string, unknown> {
  return { ...row, node_id: nodeIdOf(row["updated_at"], entry) };
}

/** nodeId from a serialized-HLC `updated_at`, or the entry timestamp's. */
function nodeIdOf(updatedAt: unknown, entry: AppSyncableRowEntry): string {
  if (typeof updatedAt === "string") {
    try {
      return deserializeHLC(updatedAt).nodeId;
    } catch {
      // Not a serialized HLC — fall through to the entry timestamp.
    }
  }
  return entry.timestamp.nodeId;
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
