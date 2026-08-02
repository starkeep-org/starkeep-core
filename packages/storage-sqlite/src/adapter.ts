import type { RawDatabase } from "@starkeep/storage-adapter";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DataRecord,
  HLCTimestamp,
  MetadataRow,
  RecordLabel,
  StarkeepId,
} from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC, sqliteMetadataTableName } from "@starkeep/protocol-primitives";
import type {
  DatabaseAdapter,
  Query,
  QueryResult,
  BatchOperation,
  Transaction,
  LabelUpsert,
  LabelRetraction,
  LabelValueReplacement,
  FindByLabelQuery,
  FindByLabelResult,
  StoredAvailability,
} from "@starkeep/storage-adapter";
import {
  StorageError,
  TransactionError,
  buildFindByLabel,
  buildGetLabel,
  buildLabelNodeWatermarks,
  buildLabelRetraction,
  buildLabelValueReplacementTombstone,
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
import { sql as kSql } from "kysely";
import { recordToRow, rowToRecord, type SqliteRow } from "./serialization.js";
import { buildSelectQuery, compiler as qb } from "./query-builder.js";
import { initializeLocalSchema } from "./schema/bootstrap.js";

export interface SqliteDatabaseAdapterOptions {
  path: string | ":memory:";
  /**
   * How to open the connection, and how to close it.
   *
   * Injected so a second SQLite driver can back this adapter rather than
   * duplicating it. Everything below this line already speaks only
   * {@link RawDatabase} — `exec` and `prepare` — which is what item 10
   * established; opening the connection was the single remaining line that
   * named `node:sqlite`, and it is the one thing that genuinely cannot be
   * driver-agnostic.
   *
   * Defaults to `node:sqlite`, so every existing caller is unchanged. React
   * Native passes an op-sqlite driver instead; see
   * `apps/mobile/src/db/op-sqlite-driver.ts` for why that one emulates
   * `prepare()` rather than using op-sqlite's prepared statements.
   */
  driver?: SqliteDriver;
}

export interface SqliteDriver {
  open(path: string): RawDatabase;
  /**
   * Separate from the connection because `RawDatabase` deliberately does not
   * carry `close()`. Consumers of a connection have no business closing it —
   * only whoever opened it does, which is this adapter.
   */
  close(db: RawDatabase): void;
}

/** The default driver: Node's built-in SQLite. */
export const nodeSqliteDriver: SqliteDriver = {
  open: (path) => new DatabaseSync(path),
  close: (db) => (db as unknown as DatabaseSync).close(),
};

/**
 * How labels are spelled on this backend: the table is flat-named, SQLite
 * having no schemas. That is now the only difference — null ordering used to be
 * a second one, and stopped being with `value` NOT NULL. Everything else about
 * label SQL lives in `@starkeep/storage-adapter`.
 */
const AVAILABILITY = "shared_object_availability";

/** The stored row shape, mapped back to the flat domain type at the boundary. */
interface AvailabilityRow {
  object_storage_key: string;
  state: string;
  tier: string | null;
  expected_latency_hours: number | null;
  ready_at_ms: number | null;
  restored_until_ms: number | null;
  observed_at_ms: number;
}

function rowToAvailability(row: AvailabilityRow): StoredAvailability {
  return {
    objectStorageKey: row.object_storage_key,
    state: row.state as StoredAvailability["state"],
    tier: row.tier,
    expectedLatencyHours: row.expected_latency_hours,
    readyAtMs: row.ready_at_ms,
    restoredUntilMs: row.restored_until_ms,
    observedAtMs: row.observed_at_ms,
  };
}

const LABELS: LabelDialect = {
  table: "shared_record_labels",
};

export class SqliteDatabaseAdapter implements DatabaseAdapter {
  private database: RawDatabase | null = null;
  private readonly options: SqliteDatabaseAdapterOptions;
  private readonly driver: SqliteDriver;

  constructor(options: SqliteDatabaseAdapterOptions) {
    this.options = options;
    this.driver = options.driver ?? nodeSqliteDriver;
  }

  async init(): Promise<void> {
    if (this.database) return;
    if (this.options.path !== ":memory:") {
      const dir = dirname(this.options.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.database = this.driver.open(this.options.path);
    initializeLocalSchema(this.database);
  }

  async close(): Promise<void> {
    if (this.database) this.driver.close(this.database);
    this.database = null;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.database) return false;
    try {
      this.database.prepare(kSql`SELECT 1`.compile(qb).sql).get();
      return true;
    } catch {
      return false;
    }
  }

  private getDatabase(): RawDatabase {
    if (!this.database) throw new StorageError("Database not initialized. Call init() first.");
    return this.database;
  }

  /**
   * The raw SQLite connection, so sibling subsystems (the sync engine's change
   * log and state store, the resident set) can create side tables in the same
   * database file. Only valid after `init()`.
   *
   * Typed as {@link RawDatabase} rather than `DatabaseSync`: returning the
   * concrete Node type is what made a second driver impossible, since every
   * consumer was then nailed to `node:sqlite`, which React Native does not
   * have. `DatabaseSync` satisfies the narrower interface structurally, so
   * nothing about this connection changes — only what callers may reach for.
   */
  getRawDatabase(): RawDatabase {
    return this.getDatabase();
  }

  private runStmt(sql: string, ...params: unknown[]): void {
    this.getDatabase().prepare(sql).run(...(params as Parameters<ReturnType<DatabaseSync["prepare"]>["run"]>));
  }

  private getRow<T = SqliteRow>(sql: string, ...params: unknown[]): T | undefined {
    return this.getDatabase().prepare(sql).get(
      ...(params as Parameters<ReturnType<DatabaseSync["prepare"]>["get"]>),
    ) as unknown as T | undefined;
  }

  private allRows<T = SqliteRow>(sql: string, ...params: unknown[]): T[] {
    return this.getDatabase().prepare(sql).all(
      ...(params as Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>),
    ) as unknown as T[];
  }

  async put(record: DataRecord): Promise<void> {
    const row = recordToRow(record);
    const updateColumns = Object.keys(row).filter((column) => column !== "id");
    const query = qb
      .insertInto("shared_records")
      .values({ ...row })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet((eb) =>
          Object.fromEntries(
            updateColumns.map((column) => [column, eb.ref(`excluded.${column}`)]),
          ),
        ),
      )
      .compile();
    this.runStmt(query.sql, ...query.parameters);
  }

  async get(id: StarkeepId): Promise<DataRecord | null> {
    const query = qb.selectFrom("shared_records").selectAll().where("id", "=", id).compile();
    const row = this.getRow<SqliteRow>(query.sql, ...query.parameters);
    return row ? rowToRecord(row) : null;
  }

  async delete(id: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    const ts = serializeHLC(hlc);
    const query = qb
      .updateTable("shared_records")
      .set({ deleted_at: ts, updated_at: ts, node_id: hlc.nodeId })
      .where("id", "=", id)
      .compile();
    this.runStmt(query.sql, ...query.parameters);
  }

  async getNodeWatermarks(): Promise<Record<string, HLCTimestamp>> {
    // Within one node_id group, updated_at is fixed-width hex up to the
    // nodeId suffix, so lexicographic MAX equals HLC MAX. The
    // (node_id, updated_at) index makes this an index-only scan.
    const watermarksQuery = qb
      .selectFrom("shared_records")
      .select(({ fn }) => ["node_id", fn.max("updated_at").as("max_updated_at")])
      .groupBy("node_id")
      .compile();
    const rows = this.allRows<{ node_id: string; max_updated_at: string }>(watermarksQuery.sql);
    const out: Record<string, HLCTimestamp> = {};
    for (const row of rows) {
      out[row.node_id] = deserializeHLC(row.max_updated_at);
    }
    return out;
  }

  async query(query: Query): Promise<QueryResult> {
    const { sql, params } = buildSelectQuery(query);
    const rows = this.allRows<SqliteRow>(sql, ...params);

    const limit = query.limit;
    const hasMore = limit ? rows.length > limit : false;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;

    return {
      records: resultRows.map(rowToRecord),
      nextCursor: hasMore ? resultRows[resultRows.length - 1].id : null,
      hasMore,
    };
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    this.getDatabase().exec("BEGIN");
    try {
      for (const operation of operations) {
        if (operation.type === "put") {
          await this.put(operation.record);
        } else {
          await this.delete(operation.id, operation.hlc);
        }
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }

  async transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    this.getDatabase().exec("SAVEPOINT starkeep_tx");
    try {
      const transaction: Transaction = {
        put: async (record) => this.put(record),
        get: async (id) => this.get(id),
        delete: async (id, hlc) => this.delete(id, hlc),
        query: async (query) => this.query(query),
      };
      const result = await callback(transaction);
      this.getDatabase().exec("RELEASE SAVEPOINT starkeep_tx");
      return result;
    } catch (error) {
      this.getDatabase().exec("ROLLBACK TO SAVEPOINT starkeep_tx");
      this.getDatabase().exec("RELEASE SAVEPOINT starkeep_tx");
      throw new TransactionError("Transaction failed", error);
    }
  }

  async putMetadata(typeId: string, row: MetadataRow): Promise<void> {
    const table = sqliteMetadataTableName(typeId);
    const values: Record<string, unknown> = { record_id: row.recordId };
    for (const [key, value] of Object.entries(row)) {
      if (key === "recordId") continue;
      values[key] = value;
    }
    const updateColumns = Object.keys(values).filter((c) => c !== "record_id");
    const query = qb
      .insertInto(table)
      .values(values)
      .onConflict((oc) =>
        updateColumns.length > 0
          ? oc.column("record_id").doUpdateSet((eb) =>
              Object.fromEntries(updateColumns.map((c) => [c, eb.ref(`excluded.${c}`)])),
            )
          : oc.column("record_id").doNothing(),
      )
      .compile();
    this.runStmt(query.sql, ...query.parameters);
  }

  async getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null> {
    const table = sqliteMetadataTableName(typeId);
    const query = qb.selectFrom(table).selectAll().where("record_id", "=", recordId).compile();
    const row = this.getRow<Record<string, unknown>>(query.sql, ...query.parameters);
    if (!row) return null;
    return columnsToMetadataRow(recordId, row);
  }

  async getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>> {
    const result = new Map<StarkeepId, MetadataRow>();
    if (recordIds.length === 0) return result;
    const table = sqliteMetadataTableName(typeId);
    const query = qb.selectFrom(table).selectAll().where("record_id", "in", recordIds).compile();
    const rows = this.allRows<Record<string, unknown>>(query.sql, ...query.parameters);
    for (const row of rows) {
      const recordId = row["record_id"] as StarkeepId;
      result.set(recordId, columnsToMetadataRow(recordId, row));
    }
    return result;
  }

  async deleteMetadata(typeId: string, recordId: StarkeepId): Promise<void> {
    const table = sqliteMetadataTableName(typeId);
    const query = qb.deleteFrom(table).where("record_id", "=", recordId).compile();
    this.runStmt(query.sql, ...query.parameters);
  }

  // ---- Cross-app record labels -------------------------------------------
  //
  // The SQL for all of these is built in `@starkeep/storage-adapter`, shared
  // with the DSQL adapter: same columns, same ON CONFLICT set, same cursor
  // predicate, same paging. Only the table name is this backend's business,
  // and it lives in LABELS above.

  async upsertLabels(labels: LabelUpsert[]): Promise<void> {
    if (labels.length === 0) return;
    const query = buildLabelUpsert(qb, LABELS, labels);
    this.runStmt(query.sql, ...query.parameters);
  }

  async retractLabels(retractions: LabelRetraction[]): Promise<void> {
    for (const r of retractions) {
      const query = buildLabelRetraction(qb, LABELS, r);
      this.runStmt(query.sql, ...query.parameters);
    }
  }

  async replaceLabelValues(replacements: LabelValueReplacement[]): Promise<void> {
    if (replacements.length === 0) return;
    // Tombstone-then-upsert per key, all in one transaction: a reader must never
    // see the moment where the old values are gone and the new ones are not yet
    // there, which for a single-valued key is the key appearing to be unset.
    this.getDatabase().exec("BEGIN");
    try {
      for (const r of replacements) {
        const tombstone = buildLabelValueReplacementTombstone(qb, LABELS, r);
        this.runStmt(tombstone.sql, ...tombstone.parameters);
        if (r.values.length > 0) {
          const upsert = buildLabelUpsert(
            qb,
            LABELS,
            r.values.map((value) => ({
              recordId: r.recordId,
              appId: r.appId,
              key: r.key,
              value,
              recordType: r.recordType,
              hlc: r.hlc,
            })),
          );
          this.runStmt(upsert.sql, ...upsert.parameters);
        }
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
  }

  async getLabelsByRecordIds(
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, RecordLabel[]>> {
    if (recordIds.length === 0) return new Map();
    const query = buildLabelsByRecordIds(qb, LABELS, recordIds);
    return groupLabelsByRecordId(
      this.allRows<LabelRow>(query.sql, ...query.parameters),
    );
  }

  async findByLabel(query: FindByLabelQuery): Promise<FindByLabelResult> {
    // `null` means the query cannot match anything — a caller with no readable
    // types — so there is nothing to ask the database.
    const compiled = buildFindByLabel(qb, LABELS, query);
    if (!compiled) return { labels: [], nextCursor: null, hasMore: false };
    const rows = this.allRows<LabelRow>(compiled.sql, ...compiled.parameters);
    return paginateFindByLabel(rows, query.limit);
  }

  // ---- Label sync ---------------------------------------------------------

  async putLabel(label: RecordLabel): Promise<void> {
    const query = buildLabelSnapshotUpsert(qb, LABELS, label);
    this.runStmt(query.sql, ...query.parameters);
  }

  async getLabel(
    recordId: StarkeepId,
    appId: string,
    key: string,
    value: string,
  ): Promise<RecordLabel | null> {
    const query = buildGetLabel(qb, LABELS, recordId, appId, key, value);
    const row = this.getRow<LabelRow>(query.sql, ...query.parameters);
    return row ? rowToLabel(row) : null;
  }

  async queryLabels(query: { limit?: number; cursor?: string }): Promise<{
    labels: RecordLabel[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const compiled = buildQueryLabels(qb, LABELS, query);
    const rows = this.allRows<LabelRow>(compiled.sql, ...compiled.parameters);
    return paginateLabelScan(rows, query.limit);
  }

  async getLabelNodeWatermarks(): Promise<Record<string, HLCTimestamp>> {
    const query = buildLabelNodeWatermarks(qb, LABELS);
    const rows = this.allRows<{ node_id: string; max_updated_at: string }>(query.sql);
    const out: Record<string, HLCTimestamp> = {};
    for (const row of rows) out[row.node_id] = deserializeHLC(row.max_updated_at);
    return out;
  }

  // ---- Object availability ------------------------------------------------

  async getAvailability(objectStorageKeys: string[]): Promise<Map<string, StoredAvailability>> {
    const out = new Map<string, StoredAvailability>();
    if (objectStorageKeys.length === 0) return out;
    const compiled = qb
      .selectFrom(AVAILABILITY)
      .selectAll()
      .where("object_storage_key", "in", objectStorageKeys)
      .compile();
    const rows = this.allRows<AvailabilityRow>(compiled.sql, ...compiled.parameters);
    for (const row of rows) out.set(row.object_storage_key, rowToAvailability(row));
    return out;
  }

  async putAvailability(row: StoredAvailability): Promise<void> {
    const compiled = qb
      .insertInto(AVAILABILITY)
      .values({
        object_storage_key: row.objectStorageKey,
        state: row.state,
        tier: row.tier,
        expected_latency_hours: row.expectedLatencyHours,
        ready_at_ms: row.readyAtMs,
        restored_until_ms: row.restoredUntilMs,
        observed_at_ms: row.observedAtMs,
      })
      .onConflict((oc) =>
        oc.column("object_storage_key").doUpdateSet((eb) => ({
          state: eb.ref("excluded.state"),
          tier: eb.ref("excluded.tier"),
          expected_latency_hours: eb.ref("excluded.expected_latency_hours"),
          ready_at_ms: eb.ref("excluded.ready_at_ms"),
          restored_until_ms: eb.ref("excluded.restored_until_ms"),
          observed_at_ms: eb.ref("excluded.observed_at_ms"),
        })),
      )
      .compile();
    this.runStmt(compiled.sql, ...compiled.parameters);
  }

  async countRestoringObjects(): Promise<{ objectCount: number; bytes: number }> {
    // Joined to records for the byte total: availability is keyed by object,
    // and only the record row knows how big the object is.
    const compiled = qb
      .selectFrom(AVAILABILITY)
      .innerJoin("shared_records", "shared_records.object_storage_key", `${AVAILABILITY}.object_storage_key`)
      .select(({ fn }) => [
        fn.count<number>(`${AVAILABILITY}.object_storage_key`).as("object_count"),
        fn.sum<number>("shared_records.size_bytes").as("bytes"),
      ])
      .where(`${AVAILABILITY}.state`, "=", kSql.lit("restoring"))
      .compile();
    const row = this.getRow<{ object_count: number; bytes: number | null }>(
      compiled.sql,
      ...compiled.parameters,
    );
    return { objectCount: row?.object_count ?? 0, bytes: row?.bytes ?? 0 };
  }

  async tombstoneLabelsForRecord(recordId: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    const query = buildTombstoneLabelsForRecord(qb, LABELS, recordId, hlc);
    this.runStmt(query.sql, ...query.parameters);
  }
}

function columnsToMetadataRow(
  recordId: StarkeepId,
  columns: Record<string, unknown>,
): MetadataRow {
  const row: MetadataRow = { recordId };
  for (const [key, value] of Object.entries(columns)) {
    if (key === "record_id") continue;
    row[key] = value;
  }
  return row;
}
