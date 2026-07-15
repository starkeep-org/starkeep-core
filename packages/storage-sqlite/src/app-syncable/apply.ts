import type { DatabaseSync } from "node:sqlite";
import { sql, type CompiledQuery } from "kysely";
import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC } from "@starkeep/protocol-primitives";
import type { AppSyncableApplier, AppSyncableRowEntry, AppSyncableNamespaceStore, ScanCapableApplier, ScanSinceOptions, ScanSincePage } from "@starkeep/shared-space-api";
import { compiler as qb } from "../query-builder.js";
import { appSyncableTableName } from "./namespace.js";

type SqlParam = null | number | bigint | string | Uint8Array;

function runCompiled(db: DatabaseSync, compiled: CompiledQuery): void {
  db.prepare(compiled.sql).run(...(compiled.parameters as SqlParam[]));
}

function allCompiled<T>(db: DatabaseSync, compiled: CompiledQuery): T[] {
  return db.prepare(compiled.sql).all(...(compiled.parameters as SqlParam[])) as T[];
}

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
    const row = withNodeId(entry.row ?? {}, entry);
    const cols = Object.keys(row);
    if (cols.length === 0) return;

    const updateCols = cols.filter((c) => !pkColumns.includes(c));
    if (pkColumns.length === 0 || updateCols.length === 0) {
      // No PK declared (or nothing beyond it) — just insert, ignoring duplicates.
      runCompiled(
        this.db,
        qb.insertInto(fullName).orIgnore().values({ ...row }).compile(),
      );
      return;
    }

    // UPSERT with LWW: only overwrite if the incoming updated_at is newer.
    runCompiled(
      this.db,
      qb
        .insertInto(fullName)
        .values({ ...row })
        .onConflict((oc) =>
          oc
            .columns(pkColumns as never[])
            .doUpdateSet((eb) =>
              Object.fromEntries(updateCols.map((c) => [c, eb.ref(`excluded.${c}`)])),
            )
            .where(sql.ref("excluded.updated_at"), ">", sql.ref(`${fullName}.updated_at`)),
        )
        .compile(),
    );
  }

  private applyUpdate(fullName: string, entry: AppSyncableRowEntry): void {
    // node_id rides along whenever updated_at changes (it's derived from it).
    const rawPatch = entry.row ?? {};
    const patch = rawPatch["updated_at"] ? withNodeId(rawPatch, entry) : rawPatch;
    const where = entry.where ?? {};
    const patchCols = Object.keys(patch);
    const whereCols = Object.keys(where);
    if (patchCols.length === 0) return;

    // Only apply if the incoming updated_at is strictly newer (LWW).
    const incomingUpdatedAt = patch["updated_at"] as string | undefined;
    let query = qb.updateTable(fullName).set({ ...patch });
    for (const c of whereCols) {
      query = query.where(c, "=", where[c]);
    }
    if (incomingUpdatedAt) {
      query = query.where("updated_at", "<", incomingUpdatedAt);
    }
    runCompiled(this.db, query.compile());
  }

  private applyDelete(fullName: string, entry: AppSyncableRowEntry): void {
    const where = entry.where ?? {};
    const whereCols = Object.keys(where);
    // Soft-delete: set deleted_at and updated_at (and node_id with it).
    const incomingUpdatedAt = entry.row?.["updated_at"] as string | undefined;
    const ts = incomingUpdatedAt ?? serializeHLC(entry.timestamp);

    let query = qb
      .updateTable(fullName)
      .set({ deleted_at: ts, updated_at: ts, node_id: nodeIdOf(ts, entry) });
    for (const c of whereCols) {
      query = query.where(c, "=", where[c]);
    }
    // LWW guard: tombstone only rows the incoming timestamp supersedes.
    query = query.where((eb) =>
      eb.or([eb("updated_at", "is", null), eb("updated_at", "<", ts)]),
    );
    runCompiled(this.db, query.compile());
  }

  /** See `ScanCapableApplier.getNodeWatermarks`. Missing table → `{}`. */
  async getNodeWatermarks(
    appId: string,
    table: string,
  ): Promise<Record<string, HLCTimestamp>> {
    const fullName = appSyncableTableName(appId, table);
    let rows: { node_id: string; max_updated_at: string }[];
    try {
      rows = allCompiled<{ node_id: string; max_updated_at: string }>(
        this.db,
        qb
          .selectFrom(fullName)
          .select(({ fn }) => ["node_id", fn.max("updated_at").as("max_updated_at")])
          .groupBy("node_id")
          .compile(),
      );
    } catch {
      // Table might not exist yet (app not installed locally).
      return {};
    }
    const out: Record<string, HLCTimestamp> = {};
    for (const row of rows) {
      out[row.node_id] = deserializeHLC(row.max_updated_at);
    }
    return out;
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
      let query = qb
        .selectFrom(fullName)
        .selectAll()
        .where("updated_at", ">", floor)
        .orderBy("updated_at", "asc");
      if (limit !== undefined) {
        query = query.limit(limit + 1);
      }
      rows = allCompiled<Record<string, unknown>>(this.db, query.compile());
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
    let query = qb.selectFrom(fullName).selectAll().where("deleted_at", "is", null);
    for (const c of whereCols) {
      query = query.where(c, "=", where![c]);
    }
    return allCompiled<Record<string, unknown>>(this.db, query.compile());
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

  // For wire propagation we emit op="insert" (upsert) for live rows so the
  // receiver creates the row if it doesn't exist yet. op="update" only
  // targets existing rows and would silently drop new rows during initial
  // sync. Tombstones still ride the soft-delete path.
  if (deletedAtStr) {
    return { timestamp, appId, table, op: "delete", row };
  }
  return { timestamp, appId, table, op: "insert", row };
}
