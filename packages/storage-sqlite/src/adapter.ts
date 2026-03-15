import { DatabaseSync } from "node:sqlite";
import type { AnyRecord, StarkeepId } from "@starkeep/core";
import type {
  DatabaseAdapter,
  Query,
  QueryResult,
  BatchOperation,
  Migration,
  Transaction,
} from "@starkeep/storage-adapter";
import { StorageError, TransactionError } from "@starkeep/storage-adapter";
import { recordToRow, rowToRecord, type SqliteRow } from "./serialization.js";
import { buildSelectQuery } from "./query-builder.js";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('data', 'metadata')),
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'local',
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT,
    object_storage_key TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    target_id TEXT,
    generator_id TEXT,
    generator_version INTEGER,
    input_hash TEXT,
    value TEXT
  )
`;

const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_records_type ON records(type)",
  "CREATE INDEX IF NOT EXISTS idx_records_sync_status ON records(sync_status)",
  "CREATE INDEX IF NOT EXISTS idx_records_target_id ON records(target_id)",
  "CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records(updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind)",
];

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

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
    this.database = new DatabaseSync(this.options.path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(CREATE_TABLE_SQL);
    for (const sql of CREATE_INDEXES_SQL) {
      this.database.exec(sql);
    }
    this.database.exec(CREATE_MIGRATIONS_TABLE_SQL);
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

  private runStmt(sql: string, ...params: unknown[]): void {
    this.getDatabase().prepare(sql).run(...(params as Parameters<ReturnType<DatabaseSync["prepare"]>["run"]>));
  }

  private getRow(sql: string, ...params: unknown[]): SqliteRow | undefined {
    return this.getDatabase().prepare(sql).get(
      ...(params as Parameters<ReturnType<DatabaseSync["prepare"]>["get"]>),
    ) as unknown as SqliteRow | undefined;
  }

  private allRows(sql: string, ...params: unknown[]): SqliteRow[] {
    return this.getDatabase().prepare(sql).all(
      ...(params as Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>),
    ) as unknown as SqliteRow[];
  }

  async put(record: AnyRecord): Promise<void> {
    const row = recordToRow(record);
    const columns = Object.keys(row);
    const placeholders = columns.map(() => "?").join(", ");
    const updates = columns
      .filter((column) => column !== "id")
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    const sql = `INSERT INTO records (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
    this.runStmt(sql, ...Object.values(row));
  }

  async get(id: StarkeepId): Promise<AnyRecord | null> {
    const row = this.getRow("SELECT * FROM records WHERE id = ?", id);
    return row ? rowToRecord(row) : null;
  }

  async delete(id: StarkeepId): Promise<void> {
    this.runStmt("DELETE FROM records WHERE id = ?", id);
  }

  async query(query: Query): Promise<QueryResult> {
    const { sql, params } = buildSelectQuery(query);
    const rows = this.allRows(sql, ...params);

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
          await this.delete(operation.id);
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
        delete: async (id) => this.delete(id),
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

  async runMigrations(migrations: Migration[]): Promise<void> {
    const applied = this.allRows("SELECT version FROM migrations ORDER BY version") as unknown as { version: number }[];
    const appliedVersions = new Set(applied.map((record) => record.version));

    const pending = migrations
      .filter((migration) => !appliedVersions.has(migration.version))
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      this.getDatabase().exec("BEGIN");
      try {
        const transaction: Transaction = {
          put: async (record) => this.put(record),
          get: async (id) => this.get(id),
          delete: async (id) => this.delete(id),
          query: async (query) => this.query(query),
        };
        await migration.up(transaction);
        this.runStmt(
          "INSERT INTO migrations (version, name) VALUES (?, ?)",
          migration.version,
          migration.name,
        );
        this.getDatabase().exec("COMMIT");
      } catch (error) {
        this.getDatabase().exec("ROLLBACK");
        throw new StorageError(
          `Migration ${migration.version} (${migration.name}) failed`,
          error,
        );
      }
    }
  }
}
