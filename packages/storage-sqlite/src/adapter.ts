import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DataRecord, HLCTimestamp, MetadataRow, StarkeepId } from "@starkeep/protocol-primitives";
import { serializeHLC, deserializeHLC, sqliteMetadataTableName } from "@starkeep/protocol-primitives";
import type {
  DatabaseAdapter,
  Query,
  QueryResult,
  BatchOperation,
  Transaction,
} from "@starkeep/storage-adapter";
import { StorageError, TransactionError } from "@starkeep/storage-adapter";
import { recordToRow, rowToRecord, type SqliteRow } from "./serialization.js";
import { buildSelectQuery } from "./query-builder.js";
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
      this.database.prepare("SELECT 1").get();
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
    const columns = Object.keys(row);
    const placeholders = columns.map(() => "?").join(", ");
    const updates = columns
      .filter((column) => column !== "id")
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    const sql = `INSERT INTO shared_records (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
    this.runStmt(sql, ...Object.values(row));
  }

  async get(id: StarkeepId): Promise<DataRecord | null> {
    const row = this.getRow<SqliteRow>("SELECT * FROM shared_records WHERE id = ?", id);
    return row ? rowToRecord(row) : null;
  }

  async delete(id: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    const ts = serializeHLC(hlc);
    this.runStmt(
      "UPDATE shared_records SET deleted_at = ?, updated_at = ?, node_id = ? WHERE id = ?",
      ts,
      ts,
      hlc.nodeId,
      id,
    );
  }

  async getNodeWatermarks(): Promise<Record<string, HLCTimestamp>> {
    // Within one node_id group, updated_at is fixed-width hex up to the
    // nodeId suffix, so lexicographic MAX equals HLC MAX. The
    // (node_id, updated_at) index makes this an index-only scan.
    const rows = this.allRows<{ node_id: string; max_updated_at: string }>(
      "SELECT node_id, MAX(updated_at) AS max_updated_at FROM shared_records GROUP BY node_id",
    );
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
    const cols: string[] = ["record_id"];
    const values: unknown[] = [row.recordId];
    for (const [key, value] of Object.entries(row)) {
      if (key === "recordId") continue;
      cols.push(key);
      values.push(value);
    }
    const placeholders = cols.map(() => "?").join(", ");
    const updates = cols
      .filter((c) => c !== "record_id")
      .map((c) => `${c} = excluded.${c}`)
      .join(", ");
    const sql = updates
      ? `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(record_id) DO UPDATE SET ${updates}`
      : `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(record_id) DO NOTHING`;
    this.runStmt(sql, ...values);
  }

  async getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null> {
    const table = sqliteMetadataTableName(typeId);
    const row = this.getRow<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE record_id = ?`,
      recordId,
    );
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
    const placeholders = recordIds.map(() => "?").join(", ");
    const rows = this.allRows<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE record_id IN (${placeholders})`,
      ...recordIds,
    );
    for (const row of rows) {
      const recordId = row["record_id"] as StarkeepId;
      result.set(recordId, columnsToMetadataRow(recordId, row));
    }
    return result;
  }

  async deleteMetadata(typeId: string, recordId: StarkeepId): Promise<void> {
    const table = sqliteMetadataTableName(typeId);
    this.runStmt(`DELETE FROM ${table} WHERE record_id = ?`, recordId);
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
