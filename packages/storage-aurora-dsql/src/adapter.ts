import type { DataRecord, MetadataRecord, StarkeepId, HLCTimestamp } from "@starkeep/core";
import { createStarkeepId, serializeHLC, deserializeHLC } from "@starkeep/core";
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
  MetadataSyncRecord,
} from "@starkeep/storage-adapter";
import { StorageError, TransactionError } from "@starkeep/storage-adapter";
import type {
  AuroraDsqlDatabaseAdapterOptions,
  DatabaseClient,
  DatabaseClientFactory,
} from "./types.js";
import { recordToRow, rowToRecord, type PostgresRow } from "./serialization.js";
import {
  buildPostgresQuery,
  buildPostgresMetadataQuery,
  metadataTableName,
  generatorIdToPrefix,
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
    size_bytes INTEGER,
    original_filename TEXT
  )
`;

const CREATE_INDEXES_SQL = [
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_type ON records(type)",
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_sync_status ON records(sync_status)",
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_updated_at ON records(updated_at)",
];

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const CREATE_METADATA_SYNC_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS metadata_sync (
    target_id          TEXT NOT NULL,
    target_type        TEXT NOT NULL,
    generator_id       TEXT NOT NULL,
    generator_version  INTEGER NOT NULL,
    input_hash         TEXT,
    updated_at         TEXT NOT NULL,
    value              TEXT NOT NULL,
    object_storage_key TEXT,
    content_hash       TEXT,
    mime_type          TEXT,
    size_bytes         BIGINT,
    PRIMARY KEY (target_id, generator_id)
  )
`;

const CREATE_METADATA_SYNC_INDEX_SQL =
  "CREATE INDEX ASYNC IF NOT EXISTS idx_metadata_sync_updated_at ON metadata_sync(updated_at)";

/** Per-type registry of generator columns. */
interface GeneratorColumnEntry {
  generatorId: string;
  columns: MetadataColumnDefinition[];
}

export class AuroraDsqlDatabaseAdapter implements DatabaseAdapter {
  private client: DatabaseClient | null = null;
  private readonly options: AuroraDsqlDatabaseAdapterOptions;
  private readonly clientFactory: DatabaseClientFactory;
  private readonly metadataRegistry = new Map<string, GeneratorColumnEntry[]>();

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
    await this.client.query(CREATE_MIGRATIONS_TABLE_SQL);
    await this.client.query(CREATE_METADATA_SYNC_TABLE_SQL);
    await this.client.query(CREATE_METADATA_SYNC_INDEX_SQL);
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
    const values = Object.values(row).map((value) =>
      typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : value,
    );
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

  async runMigrations(migrations: Migration[]): Promise<void> {
    const applied = await this.getClient().query(
      "SELECT version FROM migrations ORDER BY version",
    );
    const appliedVersions = new Set(
      applied.rows.map((record) => record.version as number),
    );

    const pending = migrations
      .filter((migration) => !appliedVersions.has(migration.version))
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      await this.getClient().query("BEGIN");
      try {
        const transaction: Transaction = {
          put: async (record) => this.put(record),
          get: async (id) => this.get(id),
          delete: async (id) => this.delete(id),
          query: async (query) => this.query(query),
        };
        await migration.up(transaction);
        await this.getClient().query(
          "INSERT INTO migrations (version, name) VALUES ($1, $2)",
          [migration.version, migration.name],
        );
        await this.getClient().query("COMMIT");
      } catch (error) {
        await this.getClient().query("ROLLBACK");
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

    await this.getClient().query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        target_id TEXT PRIMARY KEY
      )
    `);

    const postgresColumnType = (col: MetadataColumnDefinition): string => {
      switch (col.columnType) {
        case "integer": return "INTEGER";
        case "real": return "DOUBLE PRECISION";
        case "boolean": return "BOOLEAN";
        default: return "TEXT";
      }
    };

    for (const col of columns) {
      try {
        await this.getClient().query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${postgresColumnType(col)}`,
        );
      } catch {
        // Ignore.
      }
    }

    for (const [colName, colType] of [
      [`${prefix}_input_hash`, "TEXT"],
      [`${prefix}_generator_version`, "INTEGER"],
    ] as const) {
      try {
        await this.getClient().query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${colName} ${colType}`,
        );
      } catch {
        // Ignore.
      }
    }

    for (const col of columns) {
      if (col.columnType !== "boolean") {
        try {
          await this.getClient().query(
            `CREATE INDEX ASYNC IF NOT EXISTS idx_${table}_${col.name} ON ${table}(${col.name})`,
          );
        } catch {
          // Ignore.
        }
      }
    }

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
    let idx = 2;

    for (const col of generatorEntry.columns) {
      columnNames.push(col.name);
      const camelKey = snakeToCamel(col.name);
      values.push(entry.value[camelKey] ?? null);
      idx++;
    }

    columnNames.push(`${prefix}_input_hash`, `${prefix}_generator_version`);
    values.push(entry.inputHash, entry.generatorVersion);

    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
    const updateCols = columnNames.filter((c) => c !== "target_id");
    const updates = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");

    const text = `INSERT INTO ${table} (${columnNames.join(", ")}) VALUES (${placeholders}) ON CONFLICT(target_id) DO UPDATE SET ${updates}`;
    await this.getClient().query(text, values);
  }

  async queryMetadata(targetType: string, query: MetadataQuery): Promise<MetadataQueryResult> {
    const registered = this.metadataRegistry.get(targetType) ?? [];
    const { text, values } = buildPostgresMetadataQuery(targetType, query);

    const result = await this.getClient().query(text, values);
    const rows = result.rows as unknown as Record<string, unknown>[];
    const entries: MetadataRecord[] = [];

    for (const row of rows) {
      const targetId = createStarkeepId(row["target_id"] as string);

      const generatorsToReturn = query.generatorId
        ? registered.filter((g) => g.generatorId === query.generatorId)
        : registered;

      for (const gen of generatorsToReturn) {
        const prefix = generatorIdToPrefix(gen.generatorId);
        const inputHash = row[`${prefix}_input_hash`] as string | null;
        const generatorVersion = row[`${prefix}_generator_version`] as number | null;

        if (generatorVersion === null) continue;

        const value: Record<string, unknown> = {};
        for (const col of gen.columns) {
          const camelKey = snakeToCamel(col.name);
          value[camelKey] = row[col.name] ?? null;
        }

        entries.push({
          targetId,
          generatorId: gen.generatorId,
          generatorVersion,
          inputHash: inputHash ?? "",
          value,
        });
      }
    }

    return { entries };
  }

  async upsertSyncableMetadata(record: MetadataSyncRecord): Promise<void> {
    await this.getClient().query(
      `INSERT INTO metadata_sync
         (target_id, target_type, generator_id, generator_version, input_hash, updated_at, value,
          object_storage_key, content_hash, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (target_id, generator_id) DO UPDATE SET
         target_type        = EXCLUDED.target_type,
         generator_version  = EXCLUDED.generator_version,
         input_hash         = EXCLUDED.input_hash,
         updated_at         = EXCLUDED.updated_at,
         value              = EXCLUDED.value,
         object_storage_key = EXCLUDED.object_storage_key,
         content_hash       = EXCLUDED.content_hash,
         mime_type          = EXCLUDED.mime_type,
         size_bytes         = EXCLUDED.size_bytes`,
      [
        record.targetId,
        record.targetType,
        record.generatorId,
        record.generatorVersion,
        record.inputHash ?? null,
        serializeHLC(record.updatedAt),
        JSON.stringify(record.value),
        record.objectStorageKey ?? null,
        record.contentHash ?? null,
        record.mimeType ?? null,
        record.sizeBytes ?? null,
      ],
    );

    // Best-effort write to the per-type typed-column table.
    const registered = this.metadataRegistry.get(record.targetType);
    const generatorEntry = registered?.find((e) => e.generatorId === record.generatorId);
    if (generatorEntry) {
      await this.putMetadata(record.targetType, {
        targetId: record.targetId,
        generatorId: record.generatorId,
        generatorVersion: record.generatorVersion,
        inputHash: record.inputHash ?? "",
        value: record.value,
      });
    }
  }

  async getMetadataForRecord(targetId: string): Promise<Array<{
    generatorId: string;
    generatorVersion: number;
    value: Record<string, unknown>;
    updatedAt: string;
    objectStorageKey: string | null;
    mimeType: string | null;
  }>> {
    const result = await this.getClient().query(
      "SELECT generator_id, generator_version, value, updated_at, object_storage_key, mime_type FROM metadata_sync WHERE target_id = $1 ORDER BY updated_at DESC",
      [targetId],
    );
    return (result.rows as unknown as Array<{
      generator_id: string;
      generator_version: number;
      value: string;
      updated_at: string;
      object_storage_key: string | null;
      mime_type: string | null;
    }>).map((row) => ({
      generatorId: row.generator_id,
      generatorVersion: row.generator_version,
      value: JSON.parse(row.value) as Record<string, unknown>,
      updatedAt: row.updated_at,
      objectStorageKey: row.object_storage_key ?? null,
      mimeType: row.mime_type ?? null,
    }));
  }

  async getSyncableMetadataChangesSince(since: HLCTimestamp): Promise<MetadataSyncRecord[]> {
    const sinceStr = serializeHLC(since);
    const result = await this.getClient().query(
      "SELECT * FROM metadata_sync WHERE updated_at > $1 ORDER BY updated_at ASC",
      [sinceStr],
    );

    return (result.rows as unknown as Array<{
      target_id: string;
      target_type: string;
      generator_id: string;
      generator_version: number;
      input_hash: string | null;
      updated_at: string;
      value: string;
      object_storage_key: string | null;
      content_hash: string | null;
      mime_type: string | null;
      size_bytes: number | null;
    }>).map((row) => ({
      targetId: createStarkeepId(row.target_id),
      targetType: row.target_type,
      generatorId: row.generator_id,
      generatorVersion: row.generator_version,
      inputHash: row.input_hash,
      updatedAt: deserializeHLC(row.updated_at),
      value: JSON.parse(row.value) as Record<string, unknown>,
      objectStorageKey: row.object_storage_key ?? null,
      contentHash: row.content_hash ?? null,
      mimeType: row.mime_type ?? null,
      sizeBytes: row.size_bytes ?? null,
    }));
  }
}
