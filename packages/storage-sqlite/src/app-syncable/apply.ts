import type { RawDatabase } from "@starkeep/storage-adapter";
import { sql, type CompiledQuery } from "kysely";
import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC } from "@starkeep/protocol-primitives";
import type { AppSyncableApplier, AppSyncableRowEntry, AppSyncableNamespaceStore, ScanCapableApplier, ScanSincePage } from "@starkeep/shared-space-api";
import {
  buildAppAggregateQuery,
  buildAppRowQuery,
  collectAggregatePage,
  collectRowPage,
  SQLITE_APP_QUERY_DIALECT,
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
import { compiler as qb } from "../query-builder.js";
import { appSyncableTableName } from "./namespace.js";

type SqlParam = null | number | bigint | string | Uint8Array;

// Both go through `toSqliteParam` for the reason the read path does: SQLite
// binds no boolean, and a declared `boolean` column reaches here as one from
// either writer — an app's own write, normalized by `validateRow`, or a peer's
// row off the sync wire, which Postgres returns as a real boolean. The casts
// these two used to carry admitted a boolean and left the driver to reject it.
function runCompiled(db: RawDatabase, compiled: CompiledQuery): void {
  db.prepare(compiled.sql).run(...compiled.parameters.map(toSqliteParam));
}

function allCompiled<T>(db: RawDatabase, compiled: CompiledQuery): T[] {
  return db.prepare(compiled.sql).all(...compiled.parameters.map(toSqliteParam)) as T[];
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
      this.applyUpdate(fullName, pkColumns, entry);
    } else {
      this.applyDelete(fullName, pkColumns, entry);
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

  private applyUpdate(
    fullName: string,
    pkColumns: readonly string[],
    entry: AppSyncableRowEntry,
  ): void {
    // node_id rides along whenever updated_at changes (it's derived from it).
    const rawPatch = entry.row ?? {};
    const patch = rawPatch["updated_at"] ? withNodeId(rawPatch, entry) : rawPatch;
    const where = requireKeyedWhere(entry, "update", pkColumns);
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
      // `updated_at IS NULL OR updated_at < ?`, matching `applyDelete`. A bare
      // `<` is unknown against NULL, so a row with no position silently refused
      // every update while accepting every tombstone — the two halves of the
      // same LWW rule disagreeing about what "older than everything" means.
      // The column is NOT NULL wherever the installer created the table, which
      // is exactly why the inconsistency could sit here unnoticed.
      query = query.where((eb) =>
        eb.or([eb("updated_at", "is", null), eb("updated_at", "<", incomingUpdatedAt)]),
      );
    }
    runCompiled(this.db, query.compile());
  }

  private applyDelete(
    fullName: string,
    pkColumns: readonly string[],
    entry: AppSyncableRowEntry,
  ): void {
    const where = requireKeyedWhere(entry, "delete", pkColumns);
    const whereCols = Object.keys(where);
    // Soft-delete: set deleted_at and updated_at (and node_id with it).
    const incomingUpdatedAt = entry.row?.["updated_at"] as string | undefined;
    const ts = incomingUpdatedAt ?? serializeHLC(entry.timestamp);

    // A tombstone that arrived over sync carries the whole row (see
    // `rowToWireEntry`), and it has to *land* even on a node that never held
    // the row it retracts.
    //
    // As an UPDATE alone it did not: the statement matched nothing and the
    // deletion evaporated. Both sides then held different numbers of rows for
    // the same author bucket — tombstones are counted, deliberately, because a
    // deletion is a row the peer must also hold — so `verify()` reported a
    // permanent hole, armed a repair, and the repair re-shipped the same
    // tombstone into the same nothing. Forever. The nodes that hit it are
    // exactly the ones repair exists for: one that joined after the delete, or
    // one that lost the row and is being filled back in.
    //
    // Upserting is safe precisely because the wire form carries every column,
    // so nothing has to be invented for a NOT NULL the app declared. A delete
    // issued locally through the API carries only its key and its timestamp,
    // and that one still goes through the UPDATE below — the row is here by
    // construction, and inventing a half-empty row for it would be wrong.
    const carriesFullRow =
      entry.row !== undefined &&
      pkColumns.length > 0 &&
      pkColumns.every((column) => entry.row?.[column] !== undefined);
    if (carriesFullRow) {
      const row = withNodeId(
        { ...entry.row, updated_at: ts, deleted_at: ts },
        entry,
      );
      const updateCols = Object.keys(row).filter((c) => !pkColumns.includes(c));
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
              // The same LWW guard the UPDATE path carries, and for the same
              // reason: a replayed tombstone must not move a newer row back.
              .where(sql.ref("excluded.updated_at"), ">", sql.ref(`${fullName}.updated_at`)),
          )
          .compile(),
      );
      return;
    }

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

  /**
   * Whether this table exists in *this* database.
   *
   * Asked before the digest rather than inferred from a failed read, because
   * those are two different answers and only one of them is `[]`. An app that
   * is not installed here genuinely holds nothing; a table that is locked,
   * corrupt or unreadable holds an unknown number of rows, and reporting zero
   * for it is the loudest possible false alarm — every bucket in it reads as a
   * hole, in whichever direction the comparison runs.
   *
   * `sqlite_master` is the cheapest question that separates them, and asking it
   * cannot itself fail for a reason worth swallowing: a database whose schema
   * table will not read is not one whose app tables are merely absent.
   */
  private tableExists(fullName: string): boolean {
    const row = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .all(fullName);
    return row.length > 0;
  }

  /**
   * See `ScanCapableApplier.bucketDigest`. Missing table → `[]`; a table that
   * exists and will not read **throws**, so the caller's `supported: false`
   * path can do its job.
   *
   * This used to be `try { … } catch { return [] }`, which is the same mistake
   * `scanSince` made: `[]` is the wire value for "this table holds nothing", not
   * for "I could not count it". It made both engine-side "could not count ⇒
   * supported: false" guards unreachable on every production path, because no
   * real applier ever threw.
   */
  async bucketDigest(
    appId: string,
    table: string,
    prefixLength: number = DEFAULT_BUCKET_PREFIX_LENGTH,
  ): Promise<DigestBucket[]> {
    const fullName = appSyncableTableName(appId, table);
    if (!this.tableExists(fullName)) return [];
    const compiled = buildBucketDigest(qb, fullName, prefixLength);
    return toDigestBuckets(allCompiled<Record<string, unknown>>(this.db, compiled));
  }

  /**
   * See `ScanCapableApplier.getNodeWatermarks`. Missing table → `{}`; a table
   * that exists and will not read **throws**.
   *
   * The distinction matters more here than the `{}` return suggests, because
   * `scanSince` plans its authors from this map: an unreadable table that
   * answered `{}` produced no scans, and the scan then reported "nothing owed,
   * every author complete" — the exact silent-loss shape `scanSince`'s own catch
   * was written to prevent, reached one frame earlier.
   */
  async getNodeWatermarks(
    appId: string,
    table: string,
  ): Promise<Record<string, HLCTimestamp>> {
    const fullName = appSyncableTableName(appId, table);
    // Table might not exist yet (app not installed locally).
    if (!this.tableExists(fullName)) return {};
    const rows = allCompiled<{ node_id: string; max_updated_at: string }>(
      this.db,
      qb
        .selectFrom(fullName)
        .select(({ fn }) => ["node_id", fn.max("updated_at").as("max_updated_at")])
        .groupBy("node_id")
        .compile(),
    );
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
        // Converted before the row becomes a wire entry: what goes on the wire
        // is what the app sees, and a peer's applier binds a boolean it can.
        rows: fromSqliteRows(rows, booleanColumnsOf(this.namespace, appId, table))
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

  /**
   * Run a parsed query. The read half of the app-data plane.
   *
   * Compiled by the shared builder rather than here, so the SQL this emits and
   * the SQL the DSQL applier emits are one piece of code — the two hand-written
   * read grammars this replaces had already drifted on their limit defaults
   * alone.
   */
  async runQuery(
    appId: string,
    table: string,
    query: ParsedQuery,
    options: BuildOptions = {},
  ): Promise<ParsedQueryResult> {
    const fullName = appSyncableTableName(appId, table);

    const booleanColumns = booleanColumnsOf(this.namespace, appId, table);

    if (query.mode === "aggregate") {
      const compiled = buildAppAggregateQuery(
        qb,
        fullName,
        query,
        SQLITE_APP_QUERY_DIALECT,
        options,
      );
      return collectAggregatePage(
        query,
        fromSqliteRows(this.selectRows(compiled), booleanColumns),
      );
    }

    const compiled = buildAppRowQuery(qb, fullName, query, options);
    // `node:sqlite` has no streaming cursor, so the fetch budget is applied
    // over an array rather than over an iterator here. The row limit bounds what
    // that array can hold, and the response budget engages only on pathological
    // rows — so what is given up is that a page of 1 MiB text values is
    // materialized before being cut, on a server running on the operator's own
    // machine.
    // Converted before the page is collected rather than after, so the token
    // and the rows are computed from one representation.
    return collectRowPage(query, fromSqliteRows(this.selectRows(compiled), booleanColumns));
  }

  /** Bind and run a compiled SELECT, adapting values SQLite cannot bind. */
  private selectRows(compiled: CompiledQuery): Record<string, unknown>[] {
    return this.db
      .prepare(compiled.sql)
      .all(...compiled.parameters.map(toSqliteParam)) as Record<string, unknown>[];
  }
}

/**
 * The names of a table's declared `boolean` columns, or null when it has none.
 *
 * Null rather than an empty set so the caller can skip the row walk entirely,
 * which is every table today.
 */
function booleanColumnsOf(
  namespace: AppSyncableNamespaceStore,
  appId: string,
  table: string,
): Set<string> | null {
  const columns = namespace.get(appId)?.tables.find((t) => t.name === table)?.columns;
  if (!columns) return null;
  const names = columns.filter((c) => c.type === "boolean").map((c) => c.name);
  return names.length > 0 ? new Set(names) : null;
}

/**
 * The read half of the boolean conversion: `0` and `1` back to `false` and
 * `true`.
 *
 * SQLite stores a declared `boolean` as an integer, Postgres stores it as a
 * native boolean and returns one, and an app row travels the sync wire exactly
 * as its engine returned it (`rowToWireEntry`). Without this the same logical
 * row reads as `1` from the local server and `true` from the cloud, and the
 * wire form of a boolean would depend on which node happened to send it — so
 * this is what makes the JSON boolean the one app-facing and on-the-wire form
 * of the type, on both engines.
 *
 * Applies to every row leaving this applier: query rows, aggregate group keys
 * (the parser forbids an aggregate output from colliding with a column name,
 * so matching by name is unambiguous), and rows bound for the wire.
 */
function fromSqliteRows(
  rows: Record<string, unknown>[],
  booleanColumns: Set<string> | null,
): Record<string, unknown>[] {
  if (!booleanColumns) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const name of booleanColumns) {
      const value = out[name];
      if (typeof value === "number") out[name] = value !== 0;
    }
    return out;
  });
}

/**
 * SQLite binds no booleans.
 *
 * A boolean column's value is normalized to a real boolean before it reaches
 * either engine — by the parser for a predicate, by `validateRow` for a written
 * row — so both engines are handed one thing, and this is where that one thing
 * becomes the integer SQLite stores. Postgres takes the boolean unchanged,
 * which is the whole reason the normalization happens upstream rather than here.
 *
 * Every bind on this connection goes through it, reads and writes alike. A
 * conversion applied to only half the traffic is the bug this file had.
 */
function toSqliteParam(value: unknown): SqlParam {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SqlParam;
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
