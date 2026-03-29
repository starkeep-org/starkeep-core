import Database from "@tauri-apps/plugin-sql";
import type { HLCTimestamp, AnyRecord, DataRecord, MetadataRecord, StarkeepId } from "@starkeep/core";
import { serializeHLC, deserializeHLC, SyncStatus, createStarkeepId } from "@starkeep/core";
import type {
  DatabaseAdapter,
  Query,
  QueryResult,
  BatchOperation,
  Migration,
  Transaction,
} from "@starkeep/storage-adapter";
import { StorageError, TransactionError } from "@starkeep/storage-adapter";

// ---------------------------------------------------------------------------
// Schema DDL — identical to packages/storage-sqlite/src/adapter.ts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Serialization — copied from packages/storage-sqlite/src/serialization.ts
// (cannot import from @starkeep/storage-sqlite: that package uses node:sqlite)
// ---------------------------------------------------------------------------

interface SqliteRow {
  id: string;
  kind: string;
  type: string;
  created_at: string;
  updated_at: string;
  owner_id: string;
  sync_status: string;
  deleted_at: string | null;
  version: number;
  payload: string;
  content_hash: string | null;
  object_storage_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  target_id: string | null;
  generator_id: string | null;
  generator_version: number | null;
  input_hash: string | null;
  value: string | null;
}

function recordToRow(record: AnyRecord): SqliteRow {
  const base = {
    id: record.id,
    kind: record.kind,
    type: record.type,
    created_at: serializeHLC(record.createdAt),
    updated_at: serializeHLC(record.updatedAt),
    owner_id: record.ownerId,
    sync_status: record.syncStatus,
    deleted_at: record.deletedAt ? serializeHLC(record.deletedAt) : null,
    version: record.version,
  };

  if (record.kind === "data") {
    return {
      ...base,
      payload: JSON.stringify(record.payload),
      content_hash: record.contentHash,
      object_storage_key: record.objectStorageKey,
      mime_type: record.mimeType,
      size_bytes: record.sizeBytes,
      target_id: null,
      generator_id: null,
      generator_version: null,
      input_hash: null,
      value: null,
    };
  }

  return {
    ...base,
    payload: "{}",
    content_hash: null,
    object_storage_key: null,
    mime_type: null,
    size_bytes: null,
    target_id: record.targetId,
    generator_id: record.generatorId,
    generator_version: record.generatorVersion,
    input_hash: record.inputHash,
    value: JSON.stringify(record.value),
  };
}

function rowToRecord(row: SqliteRow): AnyRecord {
  const base = {
    id: createStarkeepId(row.id),
    type: row.type,
    createdAt: deserializeHLC(row.created_at),
    updatedAt: deserializeHLC(row.updated_at),
    ownerId: row.owner_id,
    syncStatus: row.sync_status as SyncStatus,
    deletedAt: row.deleted_at ? deserializeHLC(row.deleted_at) : null,
    version: row.version,
  };

  if (row.kind === "data") {
    return {
      ...base,
      kind: "data" as const,
      payload: JSON.parse(row.payload),
      contentHash: row.content_hash,
      objectStorageKey: row.object_storage_key,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
    } satisfies DataRecord;
  }

  return {
    ...base,
    kind: "metadata" as const,
    targetId: createStarkeepId(row.target_id!),
    generatorId: row.generator_id!,
    generatorVersion: row.generator_version!,
    inputHash: row.input_hash!,
    value: JSON.parse(row.value!),
  } satisfies MetadataRecord;
}

// ---------------------------------------------------------------------------
// Query builder — copied from packages/storage-sqlite/src/query-builder.ts
// Uses ? positional params (SQLite style, not $1 Postgres style)
// ---------------------------------------------------------------------------

const FIELD_MAP: Record<string, string> = {
  id: "id",
  kind: "kind",
  type: "type",
  createdAt: "created_at",
  updatedAt: "updated_at",
  ownerId: "owner_id",
  syncStatus: "sync_status",
  deletedAt: "deleted_at",
  version: "version",
  contentHash: "content_hash",
  objectStorageKey: "object_storage_key",
  mimeType: "mime_type",
  sizeBytes: "size_bytes",
  targetId: "target_id",
  generatorId: "generator_id",
  generatorVersion: "generator_version",
  inputHash: "input_hash",
};

function mapField(field: string): string {
  return FIELD_MAP[field] ?? field;
}

function buildSelectQuery(query: Query): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.type) {
    conditions.push("type = ?");
    params.push(query.type);
  }

  if (query.kind) {
    conditions.push("kind = ?");
    params.push(query.kind);
  }

  if (query.filters) {
    for (const filter of query.filters) {
      const column = mapField(filter.field);
      switch (filter.operator) {
        case "eq":
          conditions.push(`${column} = ?`);
          params.push(filter.value);
          break;
        case "neq":
          conditions.push(`${column} != ?`);
          params.push(filter.value);
          break;
        case "gt":
          conditions.push(`${column} > ?`);
          params.push(filter.value);
          break;
        case "gte":
          conditions.push(`${column} >= ?`);
          params.push(filter.value);
          break;
        case "lt":
          conditions.push(`${column} < ?`);
          params.push(filter.value);
          break;
        case "lte":
          conditions.push(`${column} <= ?`);
          params.push(filter.value);
          break;
        case "in": {
          const values = filter.value as unknown[];
          conditions.push(
            `${column} IN (${values.map(() => "?").join(", ")})`,
          );
          params.push(...values);
          break;
        }
        case "like":
          conditions.push(`${column} LIKE ?`);
          params.push(`%${filter.value}%`);
          break;
      }
    }
  }

  if (query.cursor) {
    conditions.push("id > ?");
    params.push(query.cursor);
  }

  let sql = "SELECT * FROM records";
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  if (query.sort && query.sort.length > 0) {
    const orderClauses = query.sort.map(
      (s) =>
        `${mapField(s.field)} ${s.direction === "desc" ? "DESC" : "ASC"}`,
    );
    sql += ` ORDER BY ${orderClauses.join(", ")}`;
  } else {
    sql += " ORDER BY id ASC";
  }

  if (query.limit) {
    sql += " LIMIT ?";
    params.push(query.limit + 1); // +1 to detect hasMore
  }

  return { sql, params };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class TauriDbAdapter implements DatabaseAdapter {
  private db: Database | null = null;

  async init(): Promise<void> {
    this.db = await Database.load("sqlite:tasks.db");
    await this.db.execute(CREATE_TABLE_SQL, []);
    for (const sql of CREATE_INDEXES_SQL) {
      await this.db.execute(sql, []);
    }
    await this.db.execute(CREATE_MIGRATIONS_TABLE_SQL, []);
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.db) return false;
    try {
      await this.db.select("SELECT 1", []);
      return true;
    } catch {
      return false;
    }
  }

  private getDb(): Database {
    if (!this.db) {
      throw new StorageError("Database not initialized. Call init() first.");
    }
    return this.db;
  }

  async put(record: AnyRecord): Promise<void> {
    const row = recordToRow(record);
    const columns = Object.keys(row);
    const placeholders = columns.map(() => "?").join(", ");
    const updates = columns
      .filter((c) => c !== "id")
      .map((c) => `${c} = excluded.${c}`)
      .join(", ");
    const sql = `INSERT INTO records (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
    await this.getDb().execute(sql, Object.values(row));
  }

  async get(id: StarkeepId): Promise<AnyRecord | null> {
    const rows = await this.getDb().select<SqliteRow[]>(
      "SELECT * FROM records WHERE id = ?",
      [id],
    );
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }

  async delete(id: StarkeepId): Promise<void> {
    await this.getDb().execute("DELETE FROM records WHERE id = ?", [id]);
  }

  async query(query: Query): Promise<QueryResult> {
    const { sql, params } = buildSelectQuery(query);
    const rows = await this.getDb().select<SqliteRow[]>(sql, params);
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
    await this.getDb().execute("BEGIN", []);
    try {
      for (const op of operations) {
        if (op.type === "put") await this.put(op.record);
        else await this.delete(op.id);
      }
      await this.getDb().execute("COMMIT", []);
    } catch (error) {
      await this.getDb().execute("ROLLBACK", []);
      throw error;
    }
  }

  async transaction<T>(
    callback: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    await this.getDb().execute("SAVEPOINT starkeep_tx", []);
    try {
      const tx: Transaction = {
        put: (record) => this.put(record),
        get: (id) => this.get(id),
        delete: (id) => this.delete(id),
        query: (q) => this.query(q),
      };
      const result = await callback(tx);
      await this.getDb().execute("RELEASE SAVEPOINT starkeep_tx", []);
      return result;
    } catch (error) {
      await this.getDb().execute(
        "ROLLBACK TO SAVEPOINT starkeep_tx",
        [],
      );
      await this.getDb().execute("RELEASE SAVEPOINT starkeep_tx", []);
      throw new TransactionError("Transaction failed", error);
    }
  }

  async runMigrations(migrations: Migration[]): Promise<void> {
    const applied = await this.getDb().select<{ version: number }[]>(
      "SELECT version FROM migrations ORDER BY version",
      [],
    );
    const appliedVersions = new Set(applied.map((r) => r.version));
    const pending = migrations
      .filter((m) => !appliedVersions.has(m.version))
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      await this.getDb().execute("BEGIN", []);
      try {
        const tx: Transaction = {
          put: (record) => this.put(record),
          get: (id) => this.get(id),
          delete: (id) => this.delete(id),
          query: (q) => this.query(q),
        };
        await migration.up(tx);
        await this.getDb().execute(
          "INSERT INTO migrations (version, name) VALUES (?, ?)",
          [migration.version, migration.name],
        );
        await this.getDb().execute("COMMIT", []);
      } catch (error) {
        await this.getDb().execute("ROLLBACK", []);
        throw new StorageError(
          `Migration ${migration.version} (${migration.name}) failed`,
          error,
        );
      }
    }
  }
}
