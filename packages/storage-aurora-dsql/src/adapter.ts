import type { DataRecord, MetadataRow, StarkeepId } from "@starkeep/core";
import { pgMetadataTableName } from "@starkeep/core";
import type {
  DatabaseAdapter,
  Query,
  QueryResult,
  BatchOperation,
  Transaction,
} from "@starkeep/storage-adapter";
import { StorageError, TransactionError } from "@starkeep/storage-adapter";
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
import { buildPostgresQuery } from "./query-builder.js";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending_push',
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    content_hash TEXT NOT NULL,
    object_storage_key TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    original_filename TEXT,
    origin_app_id TEXT NOT NULL,
    parent_id TEXT
  )
`;

const CREATE_INDEXES_SQL = [
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_type ON records(type)",
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_sync_status ON records(sync_status)",
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_updated_at ON records(updated_at)",
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_parent_id ON records(parent_id)",
];

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
    await this.client.query(CREATE_TABLE_SQL);
    for (const sql of CREATE_INDEXES_SQL) {
      await this.client.query(sql);
    }
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
      await this.client.query("SELECT 1");
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

  async put(record: DataRecord): Promise<void> {
    const row = recordToRow(record);
    const columns = Object.keys(row);
    const values = Object.values(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const updates = columns
      .filter((column) => column !== "id")
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(", ");

    const text = `INSERT INTO records (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
    await this.getClient().query(text, values);
  }

  async get(id: StarkeepId): Promise<DataRecord | null> {
    const result = await this.getClient().query(
      "SELECT * FROM records WHERE id = $1",
      [id],
    );
    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0] as unknown as PostgresRow);
  }

  async delete(id: StarkeepId): Promise<void> {
    await this.getClient().query("DELETE FROM records WHERE id = $1", [id]);
  }

  async query(query: Query): Promise<QueryResult> {
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

  async batch(operations: BatchOperation[]): Promise<void> {
    await this.getClient().query("BEGIN");
    try {
      for (const operation of operations) {
        if (operation.type === "put") {
          await this.put(operation.record);
        } else {
          await this.delete(operation.id);
        }
      }
      await this.getClient().query("COMMIT");
    } catch (error) {
      await this.getClient().query("ROLLBACK");
      throw error;
    }
  }

  async transaction<T>(
    callback: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    await this.getClient().query("SAVEPOINT starkeep_transaction");
    try {
      const transaction: Transaction = {
        put: async (record) => this.put(record),
        get: async (id) => this.get(id),
        delete: async (id) => this.delete(id),
        query: async (query) => this.query(query),
      };
      const result = await callback(transaction);
      await this.getClient().query("RELEASE SAVEPOINT starkeep_transaction");
      return result;
    } catch (error) {
      await this.getClient().query(
        "ROLLBACK TO SAVEPOINT starkeep_transaction",
      );
      await this.getClient().query("RELEASE SAVEPOINT starkeep_transaction");
      throw new TransactionError("Transaction failed", error);
    }
  }

  async putMetadata(typeId: string, row: MetadataRow): Promise<void> {
    const table = pgMetadataTableName(typeId);
    const cols: string[] = ["record_id"];
    const values: unknown[] = [row.recordId];
    for (const [key, value] of Object.entries(row)) {
      if (key === "recordId") continue;
      cols.push(key);
      values.push(value);
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const updates = cols
      .filter((c) => c !== "record_id")
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(", ");
    const text = updates
      ? `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(record_id) DO UPDATE SET ${updates}`
      : `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(record_id) DO NOTHING`;
    await this.getClient().query(text, values);
  }

  async getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null> {
    const table = pgMetadataTableName(typeId);
    const result = await this.getClient().query(
      `SELECT * FROM ${table} WHERE record_id = $1`,
      [recordId],
    );
    if (result.rows.length === 0) return null;
    return columnsToMetadataRow(recordId, result.rows[0] as Record<string, unknown>);
  }

  async getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>> {
    const result = new Map<StarkeepId, MetadataRow>();
    if (recordIds.length === 0) return result;
    const table = pgMetadataTableName(typeId);
    const placeholders = recordIds.map((_, i) => `$${i + 1}`).join(", ");
    const dbResult = await this.getClient().query(
      `SELECT * FROM ${table} WHERE record_id IN (${placeholders})`,
      recordIds,
    );
    for (const raw of dbResult.rows) {
      const row = raw as Record<string, unknown>;
      const recordId = row["record_id"] as StarkeepId;
      result.set(recordId, columnsToMetadataRow(recordId, row));
    }
    return result;
  }

  async deleteMetadata(typeId: string, recordId: StarkeepId): Promise<void> {
    const table = pgMetadataTableName(typeId);
    await this.getClient().query(
      `DELETE FROM ${table} WHERE record_id = $1`,
      [recordId],
    );
  }
}
