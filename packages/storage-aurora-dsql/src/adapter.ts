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
  buildFindByLabel,
  buildGetLabel,
  buildLabelNodeWatermarks,
  buildLabelRetraction,
  buildLabelSnapshotUpsert,
  buildLabelUpsert,
  buildLabelsByRecordIds,
  buildQueryLabels,
  buildTombstoneLabelsForRecord,
  groupLabelsByRecordId,
  paginateFindByLabel,
  paginateLabelScan,
  rowToLabel,
  type LabelDialect,
  type LabelRow,
} from "@starkeep/storage-adapter";
import type {
  AuroraDsqlDatabaseAdapterOptions,
  DatabaseClient,
  DatabaseClientFactory,
} from "./types.js";
import {
  recordToRow,
  rowToRecord,
  columnsToMetadataRow,
  type PostgresRow,
} from "./serialization.js";
import { buildPostgresQuery, compiler } from "./query-builder.js";
import { withOccRetry, isRetryableDsqlConflict } from "./occ-retry.js";
import { sql, type CompiledQuery } from "kysely";

/**
 * How labels are spelled on this backend. The table lives in the `shared`
 * schema, and Postgres sorts nulls *last* by default — so the reverse query's
 * nulls-first order, which the pagination cursor is defined against, has to be
 * written out. Everything else about label SQL is shared with the SQLite
 * adapter in `@starkeep/storage-adapter`.
 */
const LABELS: LabelDialect = {
  table: "shared.record_labels",
  spellOutNullsFirst: true,
};


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
  //
  // The SQL for all of these is built in `@starkeep/storage-adapter`, shared
  // with the SQLite adapter. What is this backend's own business is the OCC
  // retry wrapping every statement below: DSQL aborts transactions that race
  // on a row, and these are all replay-safe — the upsert is value-independent
  // and keyed by primary key, so a retry converges rather than compounding.

  async upsertLabels(labels: LabelUpsert[]): Promise<void> {
    if (labels.length === 0) return;
    // One multi-row statement, so a whole batch is a single round trip with no
    // read-modify-write. The caller chunks to DSQL's 3,000-modified-rows limit;
    // secondary-index entries do not count against it (measured), so the two
    // indexes on this table don't shrink the usable batch.
    await withOccRetry("upsertLabels", async () => {
      await this.run(buildLabelUpsert(compiler, LABELS, labels));
    });
  }

  async retractLabels(retractions: LabelRetraction[]): Promise<void> {
    if (retractions.length === 0) return;
    await withOccRetry("retractLabels", async () => {
      for (const r of retractions) {
        await this.run(buildLabelRetraction(compiler, LABELS, r));
      }
    });
  }

  async getLabelsByRecordIds(
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, RecordLabel[]>> {
    if (recordIds.length === 0) return new Map();
    return withOccRetry("getLabelsByRecordIds", async () => {
      const result = await this.run(buildLabelsByRecordIds(compiler, LABELS, recordIds));
      return groupLabelsByRecordId(result.rows as unknown as LabelRow[]);
    });
  }

  async findByLabel(query: FindByLabelQuery): Promise<FindByLabelResult> {
    // `null` means the query cannot match anything — a caller with no readable
    // types — so there is nothing to ask DSQL.
    const compiled = buildFindByLabel(compiler, LABELS, query);
    if (!compiled) return { labels: [], nextCursor: null, hasMore: false };
    return withOccRetry("findByLabel", async () => {
      const result = await this.run(compiled);
      return paginateFindByLabel(result.rows as unknown as LabelRow[], query.limit);
    });
  }

  // ---- Label sync ---------------------------------------------------------

  async putLabel(label: RecordLabel): Promise<void> {
    await withOccRetry("putLabel", async () => {
      await this.run(buildLabelSnapshotUpsert(compiler, LABELS, label));
    });
  }

  async getLabel(
    recordId: StarkeepId,
    appId: string,
    key: string,
  ): Promise<RecordLabel | null> {
    return withOccRetry("getLabel", async () => {
      const result = await this.run(buildGetLabel(compiler, LABELS, recordId, appId, key));
      const row = result.rows[0] as unknown as LabelRow | undefined;
      return row ? rowToLabel(row) : null;
    });
  }

  async queryLabels(query: { limit?: number; cursor?: string }): Promise<{
    labels: RecordLabel[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    return withOccRetry("queryLabels", async () => {
      const result = await this.run(buildQueryLabels(compiler, LABELS, query));
      return paginateLabelScan(result.rows as unknown as LabelRow[], query.limit);
    });
  }

  async getLabelNodeWatermarks(): Promise<Record<string, HLCTimestamp>> {
    return withOccRetry("getLabelNodeWatermarks", async () => {
      const result = await this.run(buildLabelNodeWatermarks(compiler, LABELS));
      const out: Record<string, HLCTimestamp> = {};
      for (const raw of result.rows) {
        const row = raw as Record<string, unknown>;
        out[row["node_id"] as string] = deserializeHLC(row["max_updated_at"] as string);
      }
      return out;
    });
  }

  async tombstoneLabelsForRecord(recordId: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    await withOccRetry("tombstoneLabelsForRecord", async () => {
      await this.run(buildTombstoneLabelsForRecord(compiler, LABELS, recordId, hlc));
    });
  }
}
