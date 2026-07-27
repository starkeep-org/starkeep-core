import type {
  DataRecord,
  HLCTimestamp,
  MetadataRow,
  RecordLabel,
  StarkeepId,
} from "@starkeep/protocol-primitives";
import { pgMetadataTableName, serializeHLC, deserializeHLC } from "@starkeep/protocol-primitives";
import type {
  DatabaseAdapter,
  Query,
  QueryResult,
  BatchOperation,
  Transaction,
  LabelUpsert,
  LabelRetraction,
  FindByLabelQuery,
  FindByLabelResult,
} from "@starkeep/storage-adapter";
import {
  StorageError,
  TransactionError,
  encodeLabelCursor,
  decodeLabelCursor,
} from "@starkeep/storage-adapter";
import type {
  AuroraDsqlDatabaseAdapterOptions,
  DatabaseClient,
  DatabaseClientFactory,
} from "./types.js";
import {
  recordToRow,
  rowToRecord,
  rowToLabel,
  columnsToMetadataRow,
  type PostgresRow,
  type PostgresLabelRow,
} from "./serialization.js";
import { buildPostgresQuery, compiler } from "./query-builder.js";
import { withOccRetry, isRetryableDsqlConflict } from "./occ-retry.js";
import { sql, type CompiledQuery } from "kysely";


export class AuroraDsqlDatabaseAdapter implements DatabaseAdapter {
  private client: DatabaseClient | null = null;
  private readonly options: AuroraDsqlDatabaseAdapterOptions;
  private readonly clientFactory: DatabaseClientFactory;

  constructor(
    options: AuroraDsqlDatabaseAdapterOptions,
    clientFactory: DatabaseClientFactory,
  ) {
    this.options = options;
    this.clientFactory = clientFactory;
  }

  async init(): Promise<void> {
    this.client = await this.clientFactory.createClient(this.options);
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const ping = sql`SELECT 1`.compile(compiler);
      await this.client.query(ping.sql, [...ping.parameters]);
      return true;
    } catch {
      return false;
    }
  }

  private getClient(): DatabaseClient {
    if (!this.client) {
      throw new StorageError("Database not initialized. Call init() first.");
    }
    return this.client;
  }

  // Executes a kysely-compiled query through the raw client.
  private async run(compiled: CompiledQuery) {
    return this.getClient().query(compiled.sql, [...compiled.parameters]);
  }

  async put(record: DataRecord): Promise<void> {
    await withOccRetry("put", () => this.putRaw(record));
  }

  // Raw single-statement upsert. Value-independent (the row is built from the
  // caller-supplied record, not from a prior read), so replaying it verbatim is
  // idempotent — safe for both the public `put` retry and inside batch/txn.
  private async putRaw(record: DataRecord): Promise<void> {
    const row = recordToRow(record);
    const updateColumns = Object.keys(row).filter((column) => column !== "id");
    await this.run(
      compiler
        .insertInto("shared.records")
        .values({ ...row })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) =>
            Object.fromEntries(
              updateColumns.map((column) => [column, eb.ref(`excluded.${column}`)]),
            ),
          ),
        )
        .compile(),
    );
  }

  async get(id: StarkeepId): Promise<DataRecord | null> {
    return withOccRetry("get", () => this.getRaw(id));
  }

  private async getRaw(id: StarkeepId): Promise<DataRecord | null> {
    const result = await this.run(
      compiler.selectFrom("shared.records").selectAll().where("id", "=", id).compile(),
    );
    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0] as unknown as PostgresRow);
  }

  async delete(id: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    await withOccRetry("delete", () => this.deleteRaw(id, hlc));
  }

  private async deleteRaw(id: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    const ts = serializeHLC(hlc);
    await this.run(
      compiler
        .updateTable("shared.records")
        .set({ deleted_at: ts, updated_at: ts, node_id: hlc.nodeId })
        .where("id", "=", id)
        .compile(),
    );
  }

  async getNodeWatermarks(): Promise<Record<string, HLCTimestamp>> {
    return withOccRetry("getNodeWatermarks", async () => {
      // Within one node_id group, updated_at is fixed-width hex up to the
      // nodeId suffix, so lexicographic MAX equals HLC MAX. The
      // (node_id, updated_at) index makes this an index-only scan.
      const result = await this.run(
        compiler
          .selectFrom("shared.records")
          .select(({ fn }) => ["node_id", fn.max("updated_at").as("max_updated_at")])
          .groupBy("node_id")
          .compile(),
      );
      const out: Record<string, HLCTimestamp> = {};
      for (const raw of result.rows) {
        const row = raw as Record<string, unknown>;
        out[row["node_id"] as string] = deserializeHLC(row["max_updated_at"] as string);
      }
      return out;
    });
  }

  async query(query: Query): Promise<QueryResult> {
    return withOccRetry("query", () => this.queryRaw(query));
  }

  private async queryRaw(query: Query): Promise<QueryResult> {
    const { text, values } = buildPostgresQuery(query);
    const result = await this.getClient().query(text, values);
    const rows = result.rows as unknown as PostgresRow[];

    const limit = query.limit;
    const hasMore = limit ? rows.length > limit : false;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;

    return {
      records: resultRows.map(rowToRecord),
      nextCursor: hasMore ? resultRows[resultRows.length - 1].id : null,
      hasMore,
    };
  }

  // The whole BEGIN…COMMIT is one retry unit: DSQL reports an OCC conflict at
  // COMMIT, so retrying anything narrower is wrong. `operations` is held in
  // memory and every op is an idempotent single statement, so replaying the
  // transaction from BEGIN converges. Inner ops use the raw (unwrapped) helpers
  // to avoid a redundant nested retry.
  async batch(operations: BatchOperation[]): Promise<void> {
    await withOccRetry("batch", async () => {
      await this.getClient().query("BEGIN");
      try {
        for (const operation of operations) {
          if (operation.type === "put") {
            await this.putRaw(operation.record);
          } else {
            await this.deleteRaw(operation.id, operation.hlc);
          }
        }
        await this.getClient().query("COMMIT");
      } catch (error) {
        await this.getClient().query("ROLLBACK");
        throw error;
      }
    });
  }

  // The callback is replayed verbatim on an OCC conflict (raised at RELEASE, the
  // COMMIT of the savepoint), so it MUST be idempotent — any non-DB side effects
  // it performs will run on each attempt. Inner ops use the raw helpers so the
  // conflict is handled once, at this transaction boundary.
  async transaction<T>(
    callback: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return withOccRetry("transaction", async () => {
      await this.getClient().query("SAVEPOINT starkeep_transaction");
      try {
        const transaction: Transaction = {
          put: async (record) => this.putRaw(record),
          get: async (id) => this.getRaw(id),
          delete: async (id, hlc) => this.deleteRaw(id, hlc),
          query: async (query) => this.queryRaw(query),
        };
        const result = await callback(transaction);
        await this.getClient().query("RELEASE SAVEPOINT starkeep_transaction");
        return result;
      } catch (error) {
        await this.getClient().query(
          "ROLLBACK TO SAVEPOINT starkeep_transaction",
        );
        await this.getClient().query("RELEASE SAVEPOINT starkeep_transaction");
        // Preserve OCC conflicts so withOccRetry can see and retry them;
        // wrap only genuine (non-retryable) failures as TransactionError.
        if (isRetryableDsqlConflict(error)) throw error;
        throw new TransactionError("Transaction failed", error);
      }
    });
  }

  async putMetadata(typeId: string, row: MetadataRow): Promise<void> {
    await withOccRetry("putMetadata", () => this.putMetadataRaw(typeId, row));
  }

  private async putMetadataRaw(typeId: string, row: MetadataRow): Promise<void> {
    const table = pgMetadataTableName(typeId);
    const values: Record<string, unknown> = { record_id: row.recordId };
    for (const [key, value] of Object.entries(row)) {
      if (key === "recordId") continue;
      values[key] = value;
    }
    const updateColumns = Object.keys(values).filter((c) => c !== "record_id");
    await this.run(
      compiler
        .insertInto(table)
        .values(values)
        .onConflict((oc) =>
          updateColumns.length > 0
            ? oc.column("record_id").doUpdateSet((eb) =>
                Object.fromEntries(
                  updateColumns.map((c) => [c, eb.ref(`excluded.${c}`)]),
                ),
              )
            : oc.column("record_id").doNothing(),
        )
        .compile(),
    );
  }

  async getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null> {
    return withOccRetry("getMetadata", async () => {
      const table = pgMetadataTableName(typeId);
      const result = await this.run(
        compiler.selectFrom(table).selectAll().where("record_id", "=", recordId).compile(),
      );
      if (result.rows.length === 0) return null;
      return columnsToMetadataRow(recordId, result.rows[0] as Record<string, unknown>);
    });
  }

  async getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>> {
    if (recordIds.length === 0) return new Map();
    return withOccRetry("getMetadataByIds", async () => {
      const result = new Map<StarkeepId, MetadataRow>();
      const table = pgMetadataTableName(typeId);
      const dbResult = await this.run(
        compiler.selectFrom(table).selectAll().where("record_id", "in", recordIds).compile(),
      );
      for (const raw of dbResult.rows) {
        const row = raw as Record<string, unknown>;
        const recordId = row["record_id"] as StarkeepId;
        result.set(recordId, columnsToMetadataRow(recordId, row));
      }
      return result;
    });
  }

  async deleteMetadata(typeId: string, recordId: StarkeepId): Promise<void> {
    await withOccRetry("deleteMetadata", async () => {
      const table = pgMetadataTableName(typeId);
      await this.run(
        compiler.deleteFrom(table).where("record_id", "=", recordId).compile(),
      );
    });
  }

  // ---- Cross-app record labels -------------------------------------------

  /**
   * One multi-row `INSERT … ON CONFLICT DO UPDATE`, so a whole batch is a
   * single statement with no read-modify-write round trip. Replay-safe under
   * `withOccRetry` because the statement is value-independent: every column is
   * built from the caller's input, so a retry converges rather than compounding.
   *
   * The caller chunks to DSQL's 3,000-modified-rows-per-transaction limit;
   * secondary-index entries do *not* count against that limit (measured), so
   * the two indexes on this table don't shrink the usable batch.
   */
  async upsertLabels(labels: LabelUpsert[]): Promise<void> {
    if (labels.length === 0) return;
    await withOccRetry("upsertLabels", async () => {
      await this.run(
        compiler
          .insertInto("shared.record_labels")
          .values(
            labels.map((l) => ({
              record_id: l.recordId,
              app_id: l.appId,
              key: l.key,
              value: l.value,
              record_type: l.recordType,
              created_at: serializeHLC(l.hlc),
              updated_at: serializeHLC(l.hlc),
              node_id: l.hlc.nodeId,
              deleted_at: null,
            })),
          )
          .onConflict((oc) =>
            oc.columns(["record_id", "app_id", "key"]).doUpdateSet((eb) => ({
              value: eb.ref("excluded.value"),
              record_type: eb.ref("excluded.record_type"),
              updated_at: eb.ref("excluded.updated_at"),
              node_id: eb.ref("excluded.node_id"),
              // Re-setting a retracted label revives it; otherwise a
              // set → retract → set cycle writes a row that stays invisible.
              deleted_at: null,
            })),
          )
          .compile(),
      );
    });
  }

  async retractLabels(retractions: LabelRetraction[]): Promise<void> {
    if (retractions.length === 0) return;
    await withOccRetry("retractLabels", async () => {
      for (const r of retractions) {
        // Tombstone, not DELETE: the retraction itself has to sync. Scoped by
        // primary key, which contains app_id — so "an app can only retract its
        // own labels" needs no separate check.
        await this.run(
          compiler
            .updateTable("shared.record_labels")
            .set({
              deleted_at: serializeHLC(r.hlc),
              updated_at: serializeHLC(r.hlc),
              node_id: r.hlc.nodeId,
            })
            .where("record_id", "=", r.recordId)
            .where("app_id", "=", r.appId)
            .where("key", "=", r.key)
            .compile(),
        );
      }
    });
  }

  async getLabelsByRecordIds(
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, RecordLabel[]>> {
    if (recordIds.length === 0) return new Map();
    return withOccRetry("getLabelsByRecordIds", async () => {
      const result = new Map<StarkeepId, RecordLabel[]>();
      const dbResult = await this.run(
        compiler
          .selectFrom("shared.record_labels")
          .selectAll()
          .where("record_id", "in", recordIds)
          .where("deleted_at", "is", null)
          .compile(),
      );
      for (const raw of dbResult.rows) {
        const label = rowToLabel(raw as unknown as PostgresLabelRow);
        let list = result.get(label.recordId);
        if (!list) result.set(label.recordId, (list = []));
        list.push(label);
      }
      return result;
    });
  }

  async findByLabel(query: FindByLabelQuery): Promise<FindByLabelResult> {
    return withOccRetry("findByLabel", async () => {
      const limit = query.limit ?? 50;

      let q = compiler
        .selectFrom("shared.record_labels")
        .selectAll()
        .where("app_id", "=", query.appId)
        .where("key", "=", query.key)
        // Pinned by every reverse query, and pinning it is what keeps the
        // tombstone pile out of the scanned range — `deleted_at` is the third
        // key column of idx_record_labels_reverse precisely for this, and DSQL
        // plans it as a scan key (measured: 20 index entries scanned behind
        // 20,000 tombstones, vs 20,040 without).
        .where("deleted_at", "is", null);

      if (query.value !== undefined) {
        q = q.where("value", "=", query.value);
      }

      // The caller's read grants. `record_type` is an INCLUDE payload on the
      // reverse index, so this is evaluated during the index scan rather than
      // after fetching records — which is what lets a page come back full.
      if (query.readableTypes !== undefined) {
        const types = [...query.readableTypes];
        if (types.length === 0) return { labels: [], nextCursor: null, hasMore: false };
        q = q.where("record_type", "in", types);
      }

      // "Strictly after the cursor", nulls-first. Not a row-value comparison:
      // with a null on either side that evaluates to NULL rather than false,
      // which would silently return an empty page. See label-cursor.ts.
      const cursor = query.cursor ? decodeLabelCursor(query.cursor) : null;
      if (cursor) {
        const { value, recordId } = cursor;
        q =
          value === null
            ? q.where((eb) =>
                eb.or([
                  eb("value", "is not", null),
                  eb.and([eb("value", "is", null), eb("record_id", ">", recordId)]),
                ]),
              )
            : q.where((eb) =>
                eb.or([
                  eb("value", ">", value),
                  eb.and([eb("value", "=", value), eb("record_id", ">", recordId)]),
                ]),
              );
      }

      // Postgres sorts nulls LAST by default where SQLite sorts them first.
      // Spelled out here so a cursor means the same thing on both backends.
      const compiled = q
        .orderBy(sql`value asc nulls first`)
        .orderBy("record_id", "asc")
        .limit(limit + 1)
        .compile();

      const dbResult = await this.run(compiled);
      const rows = dbResult.rows as unknown as PostgresLabelRow[];
      const hasMore = rows.length > limit;
      const labels = (hasMore ? rows.slice(0, limit) : rows).map(rowToLabel);
      const last = labels[labels.length - 1];

      return {
        labels,
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeLabelCursor({ value: last.value, recordId: last.recordId })
            : null,
      };
    });
  }

  async tombstoneLabelsForRecord(recordId: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    await withOccRetry("tombstoneLabelsForRecord", async () => {
      // Crosses app namespaces deliberately — the record is going away, so
      // every app's assertions about it go with it. A platform operation, not
      // reachable as an app write.
      await this.run(
        compiler
          .updateTable("shared.record_labels")
          .set({
            deleted_at: serializeHLC(hlc),
            updated_at: serializeHLC(hlc),
            node_id: hlc.nodeId,
          })
          .where("record_id", "=", recordId)
          .where("deleted_at", "is", null)
          .compile(),
      );
    });
  }
}
