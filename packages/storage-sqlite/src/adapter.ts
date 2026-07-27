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
  FindByLabelQuery,
  FindByLabelResult,
} from "@starkeep/storage-adapter";
import {
  StorageError,
  TransactionError,
  encodeLabelCursor,
  decodeLabelCursor,
} from "@starkeep/storage-adapter";
import { sql as kSql } from "kysely";
import {
  recordToRow,
  rowToRecord,
  rowToLabel,
  type SqliteRow,
  type SqliteLabelRow,
} from "./serialization.js";
import { buildSelectQuery, compiler as qb } from "./query-builder.js";
import { initializeLocalSchema } from "./schema/bootstrap.js";

export interface SqliteDatabaseAdapterOptions {
  path: string | ":memory:";
}

export class SqliteDatabaseAdapter implements DatabaseAdapter {
  private database: DatabaseSync | null = null;
  private readonly options: SqliteDatabaseAdapterOptions;

  constructor(options: SqliteDatabaseAdapterOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    if (this.database) return;
    if (this.options.path !== ":memory:") {
      const dir = dirname(this.options.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.database = new DatabaseSync(this.options.path);
    initializeLocalSchema(this.database);
  }

  async close(): Promise<void> {
    this.database?.close();
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

  private getDatabase(): DatabaseSync {
    if (!this.database) throw new StorageError("Database not initialized. Call init() first.");
    return this.database;
  }

  /**
   * Returns the raw SQLite connection so sibling subsystems (e.g. the sync
   * engine's change log + state store) can create side tables in the same
   * database file. Callers must only use this after `init()`.
   */
  getRawDatabase(): DatabaseSync {
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

  async upsertLabels(labels: LabelUpsert[]): Promise<void> {
    if (labels.length === 0) return;
    // One multi-row statement, not a loop: this mirrors the DSQL adapter,
    // where the difference is a transaction-per-row versus a single one.
    const query = qb
      .insertInto("shared_record_labels")
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
          // Re-setting a retracted label revives it. Without this, a
          // set → retract → set cycle would write a row that stays invisible.
          deleted_at: null,
        })),
      )
      .compile();
    this.runStmt(query.sql, ...query.parameters);
  }

  async retractLabels(retractions: LabelRetraction[]): Promise<void> {
    for (const r of retractions) {
      // Tombstone, not DELETE: the retraction itself has to sync.
      const query = qb
        .updateTable("shared_record_labels")
        .set({
          deleted_at: serializeHLC(r.hlc),
          updated_at: serializeHLC(r.hlc),
          node_id: r.hlc.nodeId,
        })
        .where("record_id", "=", r.recordId)
        // app_id is part of the primary key and is server-set, so this is
        // also the whole of "an app can only retract its own labels".
        .where("app_id", "=", r.appId)
        .where("key", "=", r.key)
        .compile();
      this.runStmt(query.sql, ...query.parameters);
    }
  }

  async getLabelsByRecordIds(
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, RecordLabel[]>> {
    const result = new Map<StarkeepId, RecordLabel[]>();
    if (recordIds.length === 0) return result;
    const query = qb
      .selectFrom("shared_record_labels")
      .selectAll()
      .where("record_id", "in", recordIds)
      .where("deleted_at", "is", null)
      .compile();
    for (const row of this.allRows<SqliteLabelRow>(query.sql, ...query.parameters)) {
      const label = rowToLabel(row);
      let list = result.get(label.recordId);
      if (!list) result.set(label.recordId, (list = []));
      list.push(label);
    }
    return result;
  }

  async findByLabel(query: FindByLabelQuery): Promise<FindByLabelResult> {
    const limit = query.limit ?? 50;

    let q = qb
      .selectFrom("shared_record_labels")
      .selectAll()
      .where("app_id", "=", query.appId)
      .where("key", "=", query.key)
      // Pinned by every reverse query — nobody asks for retracted labels — and
      // pinning it is what keeps the tombstone pile out of the scanned range.
      .where("deleted_at", "is", null);

    // Omitted value = presence filter (any value, flags included); supplied =
    // exact match. See FindByLabelQuery.value for why exact-only.
    if (query.value !== undefined) {
      q = q.where("value", "=", query.value);
    }

    // The caller's read grants, applied here rather than after fetching the
    // records, so a page comes back full.
    if (query.readableTypes !== undefined) {
      const types = [...query.readableTypes];
      if (types.length === 0) return { labels: [], nextCursor: null, hasMore: false };
      q = q.where("record_type", "in", types);
    }

    // "Strictly after the cursor", in nulls-first order. A row-value
    // comparison would be shorter but evaluates to NULL — not false — when
    // either side is null, silently returning an empty page. See
    // label-cursor.ts for why nulls-first, and why the cursor is a composite.
    const cursor = query.cursor ? decodeLabelCursor(query.cursor) : null;
    if (cursor) {
      const { value, recordId } = cursor;
      q =
        value === null
          ? // Nulls sort first, so every non-null value is past the cursor.
            q.where((eb) =>
              eb.or([
                eb("value", "is not", null),
                eb.and([eb("value", "is", null), eb("record_id", ">", recordId)]),
              ]),
            )
          : // Past the nulls entirely — a null can never follow a non-null.
            q.where((eb) =>
              eb.or([
                eb("value", ">", value),
                eb.and([eb("value", "=", value), eb("record_id", ">", recordId)]),
              ]),
            );
    }

    // SQLite's ASC is already nulls-first, which is the normalized order both
    // adapters present; the DSQL adapter has to spell out NULLS FIRST.
    q = q.orderBy("value", "asc").orderBy("record_id", "asc").limit(limit + 1);

    const compiled = q.compile();
    const rows = this.allRows<SqliteLabelRow>(compiled.sql, ...compiled.parameters);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const labels = page.map(rowToLabel);
    const last = labels[labels.length - 1];

    return {
      labels,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeLabelCursor({ value: last.value, recordId: last.recordId })
          : null,
    };
  }

  async tombstoneLabelsForRecord(recordId: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    // Crosses app namespaces deliberately — the record is going away, so every
    // app's assertions about it go with it. Not reachable as an app write.
    const query = qb
      .updateTable("shared_record_labels")
      .set({
        deleted_at: serializeHLC(hlc),
        updated_at: serializeHLC(hlc),
        node_id: hlc.nodeId,
      })
      .where("record_id", "=", recordId)
      .where("deleted_at", "is", null)
      .compile();
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
