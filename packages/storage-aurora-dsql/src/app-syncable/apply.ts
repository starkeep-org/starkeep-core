import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC } from "@starkeep/protocol-primitives";
import type {
  AppSyncableApplier,
  AppSyncableRowEntry,
  AppSyncableNamespaceStore,
  ScanCapableApplier,
  ScanSincePage,
} from "@starkeep/shared-space-api";
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
import { sql, type CompiledQuery } from "kysely";
import type { DatabaseClient } from "../types.js";
import { withOccRetry } from "../occ-retry.js";
import { compiler as qb } from "../query-builder.js";

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

  private async run(compiled: CompiledQuery): Promise<{ rows: Record<string, unknown>[] }> {
    return (await this.client.query(compiled.sql, [...compiled.parameters])) as {
      rows: Record<string, unknown>[];
    };
  }

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

    const schemaTable = `app_${entry.appId.replace(/-/g, "_")}.${entry.table}`;
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

    if (pkColumns.length === 0) {
      await this.run(
        qb
          .insertInto(schemaTable)
          .values({ ...row })
          .onConflict((oc) => oc.doNothing())
          .compile(),
      );
      return;
    }

    const updateCols = cols.filter((c) => !pkColumns.includes(c));
    if (updateCols.length === 0) {
      await this.run(
        qb
          .insertInto(schemaTable)
          .values({ ...row })
          .onConflict((oc) => oc.columns(pkColumns as never[]).doNothing())
          .compile(),
      );
      return;
    }

    await this.run(
      qb
        .insertInto(schemaTable)
        .values({ ...row })
        .onConflict((oc) =>
          oc
            .columns(pkColumns as never[])
            .doUpdateSet((eb) =>
              Object.fromEntries(updateCols.map((c) => [c, eb.ref(`excluded.${c}`)])),
            )
            .where(sql.ref("excluded.updated_at"), ">", sql.ref(`${schemaTable}.updated_at`)),
        )
        .compile(),
    );
  }

  private async applyUpdate(
    schemaTable: string,
    entry: AppSyncableRowEntry,
  ): Promise<void> {
    // node_id rides along whenever updated_at changes (it's derived from it).
    const rawPatch = entry.row ?? {};
    const patch = rawPatch["updated_at"] ? withNodeId(rawPatch, entry) : rawPatch;
    const where = requireKeyedWhere(entry, "update");
    const patchCols = Object.keys(patch);
    const whereCols = Object.keys(where);
    if (patchCols.length === 0) return;

    const incomingUpdatedAt = patch["updated_at"] as string | undefined;
    let query = qb.updateTable(schemaTable).set({ ...patch });
    for (const c of whereCols) {
      query = query.where(c, "=", where[c]);
    }
    if (incomingUpdatedAt) {
      query = query.where("updated_at", "<", incomingUpdatedAt);
    }
    await this.run(query.compile());
  }

  private async applyDelete(
    schemaTable: string,
    entry: AppSyncableRowEntry,
  ): Promise<void> {
    const where = requireKeyedWhere(entry, "delete");
    const whereCols = Object.keys(where);
    const ts = entry.row?.["updated_at"] as string ?? serializeHLC(entry.timestamp);

    let query = qb
      .updateTable(schemaTable)
      .set({ deleted_at: ts, updated_at: ts, node_id: nodeIdOf(ts, entry) });
    for (const c of whereCols) {
      query = query.where(c, "=", where[c]);
    }
    // LWW guard: tombstone only rows the incoming timestamp supersedes.
    query = query.where((eb) =>
      eb.or([eb("updated_at", "is", null), eb("updated_at", "<", ts)]),
    );
    await this.run(query.compile());
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
    const schemaTable = `app_${appId.replace(/-/g, "_")}.${table}`;
    // A missing table (app not installed here) reads as "nothing owed" rather
    // than an error, the same fail-safe direction getNodeWatermarks takes:
    // understating only causes a re-ship. That case is settled *here*, by
    // getNodeWatermarks returning {} so no author is planned — which is why
    // nothing below needs a catch for it.
    const scans = planNodeScans(await this.getNodeWatermarks(appId, table), peerWatermarks);
    const pkColumns =
      this.namespace.get(appId)?.tables.find((t) => t.name === table)?.pkColumns ?? [];
    try {
      const { rows, hasMore, truncated } = await collectSince<Record<string, unknown>>(
        scans,
        limit,
        async (scan, remaining) => {
          const result = await this.run(
            buildScanSinceForNode(qb, schemaTable, scan, remaining),
          );
          return result.rows;
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
      // A read that failed part-way has enumerated nothing it can vouch for,
      // and `truncated: {}` is the wire value for the opposite — "every author
      // complete, no ceiling". Returning that lets the round ship rows whose
      // HLCs sit above the ones this scan never reached, which is the exact
      // silent-loss shape `round-cut.ts` exists to prevent. Every planned
      // author therefore gets a `null` ceiling.
      console.warn(
        `[app-syncable] scanSince failed for ${appId}.${table}: ${(err as Error).message}`,
      );
      const truncated: Record<string, HLCTimestamp | null> = {};
      for (const scan of scans) truncated[scan.nodeId] = null;
      return { rows: [], hasMore: true, truncated };
    }
  }

  /** See `ScanCapableApplier.bucketDigest`. Missing table → `[]`. */
  async bucketDigest(
    appId: string,
    table: string,
    prefixLength: number = DEFAULT_BUCKET_PREFIX_LENGTH,
  ): Promise<DigestBucket[]> {
    const schemaTable = `app_${appId.replace(/-/g, "_")}.${table}`;
    try {
      const result = await this.run(buildBucketDigest(qb, schemaTable, prefixLength));
      return toDigestBuckets(result.rows as Record<string, unknown>[]);
    } catch {
      return [];
    }
  }

  /** See `ScanCapableApplier.getNodeWatermarks`. Missing table → `{}`. */
  async getNodeWatermarks(
    appId: string,
    table: string,
  ): Promise<Record<string, HLCTimestamp>> {
    const schemaTable = `app_${appId.replace(/-/g, "_")}.${table}`;
    let result: { rows: Record<string, unknown>[] };
    try {
      result = await this.run(
        qb
          .selectFrom(schemaTable)
          .select(({ fn }) => ["node_id", fn.max("updated_at").as("max_updated_at")])
          .groupBy("node_id")
          .compile(),
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
    const schemaTable = `app_${appId.replace(/-/g, "_")}.${table}`;
    const whereCols = where ? Object.keys(where) : [];
    let query = qb.selectFrom(schemaTable).selectAll().where("deleted_at", "is", null);
    for (const c of whereCols) {
      query = query.where(c, "=", where![c]);
    }
    const result = await this.run(query.compile());
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

// The wire-entry shape is shared with the SQLite applier — see
// `storage-adapter/src/database/app-syncable-rows.ts`. It was duplicated here,
// and both copies emitted keyless tombstones.
