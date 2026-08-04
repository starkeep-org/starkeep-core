import type { RawDatabase } from "@starkeep/storage-adapter";
import { sql, type CompiledQuery } from "kysely";
import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC } from "@starkeep/protocol-primitives";
import type { AppSyncableApplier, AppSyncableRowEntry, AppSyncableNamespaceStore, ScanCapableApplier, ScanSincePage } from "@starkeep/shared-space-api";
import {
  buildBucketDigest,
  buildScanSinceForNode,
  collectSince,
  planNodeScans,
  requireKeyedWhere,
  rowToWireEntry,
  toDigestBuckets,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DigestBucket,
} from "@starkeep/storage-adapter";
import { compiler as qb } from "../query-builder.js";
import { appSyncableTableName } from "./namespace.js";

type SqlParam = null | number | bigint | string | Uint8Array;

function runCompiled(db: RawDatabase, compiled: CompiledQuery): void {
  db.prepare(compiled.sql).run(...(compiled.parameters as SqlParam[]));
}

function allCompiled<T>(db: RawDatabase, compiled: CompiledQuery): T[] {
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
    private readonly db: RawDatabase,
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
    const where = requireKeyedWhere(entry, "update");
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
    const where = requireKeyedWhere(entry, "delete");
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

  /** See `ScanCapableApplier.bucketDigest`. Missing table → `[]`. */
  async bucketDigest(
    appId: string,
    table: string,
    prefixLength: number = DEFAULT_BUCKET_PREFIX_LENGTH,
  ): Promise<DigestBucket[]> {
    const fullName = appSyncableTableName(appId, table);
    try {
      const compiled = buildBucketDigest(qb, fullName, prefixLength);
      return toDigestBuckets(allCompiled<Record<string, unknown>>(this.db, compiled));
    } catch {
      return [];
    }
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
   * Pull-side synthesis: rows the peer hasn't seen, per author, seeking the
   * `(node_id, updated_at)` index rather than reading the table and filtering.
   * See `ScanCapableApplier.scanSince` for the contract and
   * `storage-adapter/src/database/since-queries.ts` for why it is a loop.
   */
  async scanSince(
    appId: string,
    table: string,
    peerWatermarks: Record<string, HLCTimestamp>,
    limit: number,
  ): Promise<ScanSincePage> {
    const fullName = appSyncableTableName(appId, table);
    // A missing table (app not installed locally) reads as "nothing owed"
    // rather than an error, the same fail-safe direction getNodeWatermarks
    // takes: understating only causes a re-ship. That case is settled *here*,
    // by getNodeWatermarks returning {} so no author is planned — which is why
    // nothing below needs a catch for it.
    const scans = planNodeScans(await this.getNodeWatermarks(appId, table), peerWatermarks);
    const pkColumns = this.namespace.get(appId)?.tables.find((t) => t.name === table)
      ?.pkColumns ?? [];
    try {
      const { rows, hasMore, truncated } = await collectSince<Record<string, unknown>>(
        scans,
        limit,
        async (scan, remaining) => {
          const compiled = buildScanSinceForNode(qb, fullName, scan, remaining);
          return allCompiled<Record<string, unknown>>(this.db, compiled);
        },
        (row) => deserializeHLC(row["updated_at"] as string),
      );
      return {
        rows: rows
          .map((row) => rowToWireEntry(appId, table, row, pkColumns, deserializeHLC))
          .filter((entry): entry is AppSyncableRowEntry => entry !== null),
        hasMore,
        truncated,
      };
    } catch (err) {
      // A read that failed part-way has enumerated *nothing it can vouch for*,
      // and `truncated: {}` is the wire value for the opposite — "every author
      // complete, no ceiling". Returning that lets the round ship rows whose
      // HLCs sit above the ones this scan never reached, which is the exact
      // silent-loss shape `round-cut.ts` exists to prevent.
      //
      // So every planned author gets a `null` ceiling: nothing is safe to ship
      // for any of them, and `hasMore` asks for the round to be retried.
      console.warn(
        `[app-syncable] scanSince failed for ${appId}.${table}: ${(err as Error).message}`,
      );
      const truncated: Record<string, HLCTimestamp | null> = {};
      for (const scan of scans) truncated[scan.nodeId] = null;
      return { rows: [], hasMore: true, truncated };
    }
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

// The wire-entry shape is shared with the DSQL applier — see
// `storage-adapter/src/database/app-syncable-rows.ts`. It was duplicated here,
// and both copies emitted keyless tombstones.
