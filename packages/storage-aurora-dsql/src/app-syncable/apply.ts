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
  buildAppAggregateQuery,
  buildAppRowQuery,
  collectAggregatePage,
  collectRowPage,
  POSTGRES_APP_QUERY_DIALECT,
  type BuildOptions,
  type ParsedQuery,
  type ParsedQueryResult,
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
import { isMissingRelation } from "../missing-relation.js";
import { ownerScopedCompiler, type PostgresCompiler } from "../query-builder.js";
import {
  NODE_WATERMARKS_TABLE,
  appSource,
  buildWatermarkRaises,
  readAppWatermarks,
  type WrittenStamp,
} from "../node-watermarks.js";
import { fromPgRows, pgConvertersFor, withAggregateOutputs } from "../pg-timestamps.js";

/**
 * DSQL-backed implementation of `AppSyncableApplier`.
 *
 * Tables live in `app_<appId>.<table>` (using the app's private PG schema).
 * All writes use LWW based on the HLC-serialized `updated_at` column.
 * Deletes are soft: `deleted_at` and `updated_at` are set rather than removing
 * the row so that tombstones propagate to other clients via pull.
 *
 * Every write raises the table's node watermark in its own transaction, and
 * coverage reads come from `app_<appId>._starkeep_node_watermarks`; see
 * `node-watermarks.ts`.
 */
export class DsqlAppSyncableApplier implements AppSyncableApplier, ScanCapableApplier {
  private readonly qb: PostgresCompiler;
  /**
   * Each channel's node watermarks, by table, as last read: one statement
   * serves every table's delta scan and coverage in an exchange. Every write
   * to the channel through this instance clears its entry. The broker builds
   * an applier per request, so nothing here outlives one exchange. `null`
   * means the app is not installed.
   */
  private readonly watermarks = new Map<string, Map<string, Record<string, HLCTimestamp>> | null>();

  constructor(
    private readonly client: DatabaseClient,
    private readonly namespace: AppSyncableNamespaceStore,
    /** The user whose rows this applier reads and writes. See `owner-scope.ts`. */
    readonly ownerId: string,
  ) {
    this.qb = ownerScopedCompiler(ownerId);
  }

  private async run(compiled: CompiledQuery): Promise<{ rows: Record<string, unknown>[] }> {
    return (await this.client.query(compiled.sql, [...compiled.parameters])) as {
      rows: Record<string, unknown>[];
    };
  }

  // Each branch is a single LWW-guarded statement (upsert / conditional
  // update / soft-delete keyed on `updated_at`), and the raise after it is
  // monotonic, so replaying the whole transaction on an OCC conflict is
  // idempotent. DSQL reports the conflict at COMMIT, so the transaction is the
  // retry unit.
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

    // A write that loses LWW lands no row with this stamp, so its raise
    // records nothing, which understates and is safe.
    const raises = buildWatermarkRaises(this.qb, appSource(entry.appId, entry.table), [
      writtenStampOf(entry),
    ]);
    await withOccRetry(`applier.apply(${entry.op})`, async () => {
      try {
        await this.client.query("BEGIN");
        try {
          if (entry.op === "insert") {
            await this.applyInsert(schemaTable, pkColumns, entry);
          } else if (entry.op === "update") {
            await this.applyUpdate(schemaTable, pkColumns, entry);
          } else {
            await this.applyDelete(schemaTable, pkColumns, entry);
          }
          for (const raise of raises) await this.run(raise);
          await this.client.query("COMMIT");
        } catch (error) {
          await this.client.query("ROLLBACK");
          throw error;
        }
      } finally {
        this.watermarks.delete(entry.appId);
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
        this.qb
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
        this.qb
          .insertInto(schemaTable)
          .values({ ...row })
          .onConflict((oc) => oc.columns(pkColumns as never[]).doNothing())
          .compile(),
      );
      return;
    }

    await this.run(
      this.qb
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
    pkColumns: readonly string[],
    entry: AppSyncableRowEntry,
  ): Promise<void> {
    // node_id rides along whenever updated_at changes (it's derived from it).
    const rawPatch = entry.row ?? {};
    const patch = rawPatch["updated_at"] ? withNodeId(rawPatch, entry) : rawPatch;
    const where = requireKeyedWhere(entry, "update", pkColumns);
    const patchCols = Object.keys(patch);
    const whereCols = Object.keys(where);
    if (patchCols.length === 0) return;

    const incomingUpdatedAt = patch["updated_at"] as string | undefined;
    let query = this.qb.updateTable(schemaTable).set({ ...patch });
    for (const c of whereCols) {
      query = query.where(c, "=", where[c]);
    }
    if (incomingUpdatedAt) {
      // `updated_at IS NULL OR updated_at < ?`, matching `applyDelete`. A bare
      // `<` is unknown against NULL, so a row with no position silently refused
      // every update while accepting every tombstone — the two halves of the
      // same LWW rule disagreeing about what "older than everything" means.
      query = query.where((eb) =>
        eb.or([eb("updated_at", "is", null), eb("updated_at", "<", incomingUpdatedAt)]),
      );
    }
    await this.run(query.compile());
  }

  private async applyDelete(
    schemaTable: string,
    pkColumns: readonly string[],
    entry: AppSyncableRowEntry,
  ): Promise<void> {
    const where = requireKeyedWhere(entry, "delete", pkColumns);
    const whereCols = Object.keys(where);
    const ts = (entry.row?.["updated_at"] as string) ?? serializeHLC(entry.timestamp);

    // A tombstone that arrived over sync carries the whole row, and it has to
    // land even on a node that never held the row it retracts. As an UPDATE
    // alone it matched nothing and the deletion evaporated, leaving the two
    // sides counting different numbers of rows in one bucket — a divergence
    // `verify()` reports forever and repair cannot fill, because re-shipping
    // the tombstone runs into the same nothing. See the SQLite applier's
    // `applyDelete` for the long version. A delete issued locally carries only
    // its key and goes through the UPDATE below, where the row exists by
    // construction.
    const carriesFullRow =
      entry.row !== undefined &&
      pkColumns.length > 0 &&
      pkColumns.every((column) => entry.row?.[column] !== undefined);
    if (carriesFullRow) {
      const row = withNodeId({ ...entry.row, updated_at: ts, deleted_at: ts }, entry);
      const updateCols = Object.keys(row).filter((c) => !pkColumns.includes(c));
      await this.run(
        this.qb
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
      return;
    }

    let query = this.qb
      .updateTable(schemaTable)
      .set({ deleted_at: ts, updated_at: ts, node_id: nodeIdOf(ts, entry) });
    for (const c of whereCols) {
      query = query.where(c, "=", where[c]);
    }
    // LWW guard: tombstone only rows the incoming timestamp supersedes.
    query = query.where((eb) => eb.or([eb("updated_at", "is", null), eb("updated_at", "<", ts)]));
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
            buildScanSinceForNode(this.qb, schemaTable, scan, remaining),
          );
          return result.rows;
        },
        (row) => deserializeHLC(row["updated_at"] as string),
      );
      return {
        // Converted before the row becomes a wire entry, exactly as the SQLite
        // side converts its booleans: what goes on the wire is what the app
        // sees. Without this a declared `timestamp` shipped from the cloud
        // carried Postgres' own rendering — `2026-01-01 00:00:00`, no `T` and
        // no `Z` — and the peer stored that verbatim.
        rows: fromPgRows(rows, this.convertersFor(appId, table))
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

  /**
   * See `ScanCapableApplier.bucketDigest`. Missing table → `[]`; a table that
   * exists and will not read **throws**, so the caller's `supported: false`
   * path can do its job.
   *
   * This used to swallow every error into `[]`, which is the same mistake
   * `scanSince` made: `[]` is the wire value for "this table holds nothing", not
   * for "I could not count it". A revoked GRANT then read as a lost library, in
   * whichever direction the digest comparison happened to run.
   */
  async bucketDigest(
    appId: string,
    table: string,
    prefixLength: number = DEFAULT_BUCKET_PREFIX_LENGTH,
  ): Promise<DigestBucket[]> {
    const schemaTable = `app_${appId.replace(/-/g, "_")}.${table}`;
    try {
      const result = await this.run(buildBucketDigest(this.qb, schemaTable, prefixLength));
      return toDigestBuckets(result.rows as Record<string, unknown>[]);
    } catch (err) {
      if (isMissingRelation(err)) return [];
      throw err;
    }
  }

  /**
   * See `ScanCapableApplier.getNodeWatermarks`. An app that is not installed
   * → `{}`; a watermark table that will not read **throws**.
   *
   * The distinction matters more here than the `{}` return suggests, because
   * `scanSince` plans its authors from this map: an unreadable table that
   * answered `{}` produced no scans, and the scan then reported "nothing owed,
   * every author complete" — the exact silent-loss shape `scanSince`'s own catch
   * was written to prevent, reached one frame earlier. The coverage report
   * would also say "nothing", and every requester would ship its whole
   * history. Throwing makes the transport report incomplete coverage instead,
   * so requesters merge upward.
   */
  async getNodeWatermarks(appId: string, table: string): Promise<Record<string, HLCTimestamp>> {
    // A table the app never declared holds nothing here.
    const ns = this.namespace.get(appId);
    if (ns && !ns.tables.some((t) => t.name === table)) return {};
    const channel = await this.channelWatermarks(appId);
    return { ...channel?.get(table) };
  }

  /** Every table's node watermarks on `appId`'s channel, read once between writes. */
  private async channelWatermarks(
    appId: string,
  ): Promise<Map<string, Record<string, HLCTimestamp>> | null> {
    if (this.watermarks.has(appId)) return this.watermarks.get(appId)!;
    let read: Map<string, Record<string, HLCTimestamp>> | null;
    try {
      read = await readAppWatermarks(this.client, this.qb, appId);
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
      // The app isn't installed on this instance. Omitting its nodes only
      // understates the coverage watermark, which is the safe direction
      // (re-ship, idempotent LWW).
      if (!this.namespace.get(appId)) {
        read = null;
      } else {
        throw new Error(
          `app "${appId}" is installed but has no ${NODE_WATERMARKS_TABLE} table; reinstall it`,
          { cause: err },
        );
      }
    }
    this.watermarks.set(appId, read);
    return read;
  }

  /**
   * Run a parsed query. The read half of the app-data plane.
   *
   * Compiled by the shared builder rather than here, so the SQL this emits and
   * the SQL the SQLite applier emits are one piece of code — the two
   * hand-written read grammars this replaces had already drifted on their limit
   * defaults alone.
   */
  async runQuery(
    appId: string,
    table: string,
    query: ParsedQuery,
    options: BuildOptions = {},
  ): Promise<ParsedQueryResult> {
    const schemaTable = `app_${appId.replace(/-/g, "_")}.${table}`;

    if (query.mode === "aggregate") {
      const compiled = buildAppAggregateQuery(
        this.qb,
        schemaTable,
        query,
        POSTGRES_APP_QUERY_DIALECT,
        options,
      );
      const result = await this.run(compiled);
      return collectAggregatePage(
        query,
        fromPgRows(
          result.rows,
          withAggregateOutputs(this.convertersFor(appId, table), query.aggregates),
        ),
      );
    }

    const compiled = buildAppRowQuery(this.qb, schemaTable, query, options);
    // The broker holds a plain `pg` client rather than a cursor, so the rows
    // arrive as an array and the fetch budget is applied over it. The row limit
    // bounds what that array can hold; the response budget's job here is to keep
    // a page of pathological rows from failing at Lambda's 6 MB synchronous
    // response ceiling, which it still does.
    const { rows } = await this.run(compiled);
    // Converted before the page is collected rather than after, so the page
    // token is cut from the same representation the rows carry.
    return collectRowPage(query, fromPgRows(rows, this.convertersFor(appId, table)));
  }

  /** The value conversions a declared table's columns call for on this engine. */
  private convertersFor(appId: string, table: string) {
    return pgConvertersFor(
      this.namespace.get(appId)?.tables.find((t) => t.name === table)?.columns,
    );
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

/**
 * The stamp an entry's write lands, by the same rules the branches above
 * write `updated_at`.
 */
function writtenStampOf(entry: AppSyncableRowEntry): WrittenStamp {
  const updatedAt = entry.row?.["updated_at"];
  const stamp = typeof updatedAt === "string" ? updatedAt : serializeHLC(entry.timestamp);
  return { nodeId: nodeIdOf(stamp, entry), stamp };
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
