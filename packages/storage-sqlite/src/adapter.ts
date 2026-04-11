import { DatabaseSync } from "node:sqlite";
import type { DataRecord, MetadataRecord, StarkeepId } from "@starkeep/core";
import { createStarkeepId } from "@starkeep/core";
import type {
  DatabaseAdapter,
  Query,
  QueryResult,
  BatchOperation,
  Migration,
  Transaction,
  MetadataColumnDefinition,
  MetadataQuery,
  MetadataQueryResult,
} from "@starkeep/storage-adapter";
import { StorageError, TransactionError } from "@starkeep/storage-adapter";
import { recordToRow, rowToRecord, type SqliteRow } from "./serialization.js";
import {
  buildSelectQuery,
  buildMetadataSelectQuery,
  metadataTableName,
  generatorIdToPrefix,
  camelToSnake,
  snakeToCamel,
} from "./query-builder.js";

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'local',
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT,
    object_storage_key TEXT,
    mime_type TEXT,
    size_bytes INTEGER
  )
`;

const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_records_type ON records(type)",
  "CREATE INDEX IF NOT EXISTS idx_records_sync_status ON records(sync_status)",
  "CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records(updated_at)",
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

/** Per-type registry of generator columns, used when building metadata queries. */
interface GeneratorColumnEntry {
  generatorId: string;
  columns: MetadataColumnDefinition[];
}

export class SqliteDatabaseAdapter implements DatabaseAdapter {
  private database: DatabaseSync | null = null;
  private readonly options: SqliteDatabaseAdapterOptions;
  /** targetType → list of {generatorId, columns} registered via ensureMetadataTable */
  private readonly metadataRegistry = new Map<string, GeneratorColumnEntry[]>();

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
    const sql = `INSERT INTO records (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
    this.runStmt(sql, ...Object.values(row));
  }

  async get(id: StarkeepId): Promise<DataRecord | null> {
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
    const applied = this.allRows<{ version: number }>("SELECT version FROM migrations ORDER BY version");
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

  // ---------------------------------------------------------------------------
  // Per-type metadata table methods
  // ---------------------------------------------------------------------------

  async ensureMetadataTable(
    targetType: string,
    generatorId: string,
    columns: MetadataColumnDefinition[],
  ): Promise<void> {
    const table = metadataTableName(targetType);
    const prefix = generatorIdToPrefix(generatorId);

    // Ensure the table exists with at least target_id as PK.
    this.getDatabase().exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        target_id TEXT PRIMARY KEY
      )
    `);

    // Add per-generator value columns (idempotent: ALTER TABLE ADD COLUMN IF NOT EXISTS via try/catch).
    const sqliteColumnType = (col: MetadataColumnDefinition): string => {
      switch (col.columnType) {
        case "integer": return "INTEGER";
        case "real": return "REAL";
        case "boolean": return "INTEGER"; // SQLite stores booleans as 0/1
        default: return "TEXT";
      }
    };

    for (const col of columns) {
      try {
        this.getDatabase().exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${sqliteColumnType(col)}`);
      } catch {
        // Column already exists — ignore.
      }
    }

    // Add per-generator staleness columns.
    for (const colName of [`${prefix}_input_hash`, `${prefix}_generator_version`]) {
      try {
        const colType = colName.endsWith("_generator_version") ? "INTEGER" : "TEXT";
        this.getDatabase().exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colType}`);
      } catch {
        // Column already exists — ignore.
      }
    }

    // Create index on target_id (already PK, but add generator-specific indexes).
    for (const col of columns) {
      if (col.columnType !== "boolean") {
        try {
          this.getDatabase().exec(
            `CREATE INDEX IF NOT EXISTS idx_${table}_${col.name} ON ${table}(${col.name})`,
          );
        } catch {
          // Ignore.
        }
      }
    }

    // Register in memory for query building.
    const existing = this.metadataRegistry.get(targetType) ?? [];
    if (!existing.some((e) => e.generatorId === generatorId)) {
      existing.push({ generatorId, columns });
      this.metadataRegistry.set(targetType, existing);
    }
  }

  async putMetadata(targetType: string, entry: MetadataRecord): Promise<void> {
    const table = metadataTableName(targetType);
    const prefix = generatorIdToPrefix(entry.generatorId);
    const registered = this.metadataRegistry.get(targetType);
    const generatorEntry = registered?.find((e) => e.generatorId === entry.generatorId);

    if (!generatorEntry) {
      throw new StorageError(
        `Metadata table for type "${targetType}" / generator "${entry.generatorId}" not registered. Call ensureMetadataTable first.`,
      );
    }

    const columnNames: string[] = ["target_id"];
    const values: unknown[] = [entry.targetId];

    // Map value keys (camelCase) → column names (snake_case).
    for (const col of generatorEntry.columns) {
      columnNames.push(col.name);
      const camelKey = snakeToCamel(col.name);
      values.push(entry.value[camelKey] ?? null);
    }

    // Staleness tracking columns.
    columnNames.push(`${prefix}_input_hash`, `${prefix}_generator_version`);
    values.push(entry.inputHash, entry.generatorVersion);

    const placeholders = columnNames.map(() => "?").join(", ");
    // Only update columns belonging to this generator (not other generators' columns).
    const updateCols = columnNames.filter((c) => c !== "target_id");
    const updates = updateCols.map((c) => `${c} = excluded.${c}`).join(", ");

    const sql = `INSERT INTO ${table} (${columnNames.join(", ")}) VALUES (${placeholders}) ON CONFLICT(target_id) DO UPDATE SET ${updates}`;
    this.runStmt(sql, ...values);
  }

  async queryMetadata(targetType: string, query: MetadataQuery): Promise<MetadataQueryResult> {
    const registered = this.metadataRegistry.get(targetType) ?? [];
    const { sql, params } = buildMetadataSelectQuery(targetType, query, registered);

    const rows = this.allRows<Record<string, unknown>>(sql, ...params);
    const entries: MetadataRecord[] = [];

    for (const row of rows) {
      const targetId = createStarkeepId(row["target_id"] as string);

      // Determine which generators to return entries for.
      const generatorsToReturn = query.generatorId
        ? registered.filter((g) => g.generatorId === query.generatorId)
        : registered;

      for (const gen of generatorsToReturn) {
        const prefix = generatorIdToPrefix(gen.generatorId);
        const inputHash = row[`${prefix}_input_hash`] as string | null;
        const generatorVersion = row[`${prefix}_generator_version`] as number | null;

        // Skip generators that haven't produced any output for this row yet.
        if (inputHash === null || generatorVersion === null) continue;

        // Reconstruct value object from columns (snake_case → camelCase).
        const value: Record<string, unknown> = {};
        for (const col of gen.columns) {
          const camelKey = snakeToCamel(col.name);
          value[camelKey] = row[col.name] ?? null;
        }

        entries.push({
          targetId,
          generatorId: gen.generatorId,
          generatorVersion,
          inputHash,
          value,
        });
      }
    }

    return { entries };
  }
}
