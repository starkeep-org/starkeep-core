/**
 * SQLite DatabaseAdapter implemented with bun:sqlite.
 *
 * This avoids the node:sqlite dependency in @starkeep/storage-sqlite, which
 * Bun cannot resolve when compiling a standalone binary. The schema, DDL,
 * serialization, and query-builder logic are identical to the node:sqlite
 * adapter — only the driver calls differ.
 */

import { Database } from "bun:sqlite";
import type { DataRecord, MetadataRecord, StarkeepId } from "@starkeep/core";
import { serializeHLC, deserializeHLC, SyncStatus, createStarkeepId } from "@starkeep/core";
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

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

interface SqliteRow {
  id: string;
  type: string;
  created_at: string;
  updated_at: string;
  owner_id: string;
  sync_status: string;
  deleted_at: string | null;
  version: number;
  content: string;
  content_hash: string | null;
  object_storage_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

function recordToRow(record: DataRecord): SqliteRow {
  return {
    id: record.id,
    type: record.type,
    created_at: serializeHLC(record.createdAt),
    updated_at: serializeHLC(record.updatedAt),
    owner_id: record.ownerId,
    sync_status: record.syncStatus,
    deleted_at: record.deletedAt ? serializeHLC(record.deletedAt) : null,
    version: record.version,
    content: JSON.stringify(record.content),
    content_hash: record.contentHash,
    object_storage_key: record.objectStorageKey,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
  };
}

function rowToRecord(row: SqliteRow): DataRecord {
  return {
    id: createStarkeepId(row.id),
    kind: "data",
    type: row.type,
    createdAt: deserializeHLC(row.created_at),
    updatedAt: deserializeHLC(row.updated_at),
    ownerId: row.owner_id,
    syncStatus: row.sync_status as SyncStatus,
    deletedAt: row.deleted_at ? deserializeHLC(row.deleted_at) : null,
    version: row.version,
    content: JSON.parse(row.content),
    contentHash: row.content_hash,
    objectStorageKey: row.object_storage_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function camelToSnake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function generatorIdToPrefix(generatorId: string): string {
  return generatorId
    .replace(/^@/, "")
    .replace(/[/:@\-]/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "");
}

function metadataTableName(targetType: string): string {
  const sanitized = targetType
    .replace(/^@/, "")
    .replace(/[/:@\-]/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "");
  return `metadata_${sanitized}`;
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

const FIELD_MAP: Record<string, string> = {
  id: "id",
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
};

function mapField(field: string): string {
  if (field.startsWith("content.")) {
    const jsonKey = field.slice("content.".length);
    return `json_extract(content, '$.${jsonKey}')`;
  }
  return FIELD_MAP[field] ?? field;
}

function buildSelectQuery(query: Query): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.type) { conditions.push("type = ?"); params.push(query.type); }

  if (query.filters) {
    for (const filter of query.filters) {
      const column = mapField(filter.field);
      switch (filter.operator) {
        case "eq":   conditions.push(`${column} = ?`);  params.push(filter.value); break;
        case "neq":  conditions.push(`${column} != ?`); params.push(filter.value); break;
        case "gt":   conditions.push(`${column} > ?`);  params.push(filter.value); break;
        case "gte":  conditions.push(`${column} >= ?`); params.push(filter.value); break;
        case "lt":   conditions.push(`${column} < ?`);  params.push(filter.value); break;
        case "lte":  conditions.push(`${column} <= ?`); params.push(filter.value); break;
        case "in": {
          const values = filter.value as unknown[];
          conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
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

  if (query.cursor) { conditions.push("id > ?"); params.push(query.cursor); }

  let sql = "SELECT * FROM records";
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;

  if (query.sort && query.sort.length > 0) {
    sql += ` ORDER BY ${query.sort.map(s => `${mapField(s.field)} ${s.direction === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
  } else {
    sql += " ORDER BY id ASC";
  }

  if (query.limit) { sql += " LIMIT ?"; params.push(query.limit + 1); }

  return { sql, params };
}

function buildMetadataSelectQuery(
  targetType: string,
  query: MetadataQuery,
): { sql: string; params: unknown[] } {
  const table = metadataTableName(targetType);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.targetId) {
    conditions.push("target_id = ?");
    params.push(query.targetId);
  } else if (query.targetIds && query.targetIds.length > 0) {
    conditions.push(`target_id IN (${query.targetIds.map(() => "?").join(", ")})`);
    params.push(...query.targetIds);
  }

  if (query.filters) {
    for (const filter of query.filters) {
      const column = camelToSnake(filter.field);
      switch (filter.operator) {
        case "eq":   conditions.push(`${column} = ?`);  params.push(filter.value); break;
        case "neq":  conditions.push(`${column} != ?`); params.push(filter.value); break;
        case "in": {
          const values = filter.value as unknown[];
          conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
          params.push(...values);
          break;
        }
        default:
          conditions.push(`${column} ${filter.operator} ?`);
          params.push(filter.value);
      }
    }
  }

  let sql = `SELECT * FROM ${table}`;
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface GeneratorColumnEntry {
  generatorId: string;
  columns: MetadataColumnDefinition[];
}

export interface BunSqliteDatabaseAdapterOptions {
  path: string;
}

export class BunSqliteDatabaseAdapter implements DatabaseAdapter {
  private db: Database | null = null;
  private readonly path: string;
  private readonly metadataRegistry = new Map<string, GeneratorColumnEntry[]>();

  constructor(options: BunSqliteDatabaseAdapterOptions) {
    this.path = options.path;
  }

  async init(): Promise<void> {
    this.db = new Database(this.path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(CREATE_TABLE_SQL);
    for (const sql of CREATE_INDEXES_SQL) this.db.exec(sql);
    this.db.exec(CREATE_MIGRATIONS_TABLE_SQL);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.getDb().query("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  private getDb(): Database {
    if (!this.db) throw new StorageError("Database not initialized. Call init() first.");
    return this.db;
  }

  async put(record: DataRecord): Promise<void> {
    const row = recordToRow(record);
    const columns = Object.keys(row);
    const placeholders = columns.map(() => "?").join(", ");
    const updates = columns.filter(c => c !== "id").map(c => `${c} = excluded.${c}`).join(", ");
    const sql = `INSERT INTO records (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
    this.getDb().run(sql, Object.values(row) as string[]);
  }

  async get(id: StarkeepId): Promise<DataRecord | null> {
    const row = this.getDb().query<SqliteRow, [string]>("SELECT * FROM records WHERE id = ?").get(id as string);
    return row ? rowToRecord(row) : null;
  }

  async delete(id: StarkeepId): Promise<void> {
    this.getDb().run("DELETE FROM records WHERE id = ?", [id as string]);
  }

  async query(query: Query): Promise<QueryResult> {
    const { sql, params } = buildSelectQuery(query);
    const rows = this.getDb().query<SqliteRow, unknown[]>(sql).all(params);
    const limit = query.limit;
    const hasMore = limit ? rows.length > limit : false;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      records: resultRows.map(rowToRecord),
      nextCursor: hasMore ? resultRows[resultRows.length - 1]!.id : null,
      hasMore,
    };
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    const db = this.getDb();
    const run = db.transaction(() => {
      for (const op of operations) {
        if (op.type === "put") {
          const row = recordToRow(op.record);
          const columns = Object.keys(row);
          const placeholders = columns.map(() => "?").join(", ");
          const updates = columns.filter(c => c !== "id").map(c => `${c} = excluded.${c}`).join(", ");
          db.run(
            `INSERT INTO records (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`,
            Object.values(row) as string[],
          );
        } else {
          db.run("DELETE FROM records WHERE id = ?", [op.id as string]);
        }
      }
    });
    run();
  }

  async transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    const db = this.getDb();
    db.run("SAVEPOINT starkeep_tx");
    try {
      const tx: Transaction = {
        put: (r) => this.put(r),
        get: (id) => this.get(id),
        delete: (id) => this.delete(id),
        query: (q) => this.query(q),
      };
      const result = await callback(tx);
      db.run("RELEASE SAVEPOINT starkeep_tx");
      return result;
    } catch (error) {
      db.run("ROLLBACK TO SAVEPOINT starkeep_tx");
      db.run("RELEASE SAVEPOINT starkeep_tx");
      throw new TransactionError("Transaction failed", error);
    }
  }

  async runMigrations(migrations: Migration[]): Promise<void> {
    const db = this.getDb();
    const applied = db.query<{ version: number }, []>("SELECT version FROM migrations ORDER BY version").all();
    const appliedVersions = new Set(applied.map(r => r.version));
    const pending = migrations.filter(m => !appliedVersions.has(m.version)).sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      db.run("BEGIN");
      try {
        const tx: Transaction = {
          put: (r) => this.put(r),
          get: (id) => this.get(id),
          delete: (id) => this.delete(id),
          query: (q) => this.query(q),
        };
        await migration.up(tx);
        db.run("INSERT INTO migrations (version, name) VALUES (?, ?)", [migration.version, migration.name]);
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw new StorageError(`Migration ${migration.version} (${migration.name}) failed`, error);
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
    const db = this.getDb();

    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (target_id TEXT PRIMARY KEY)`);

    const sqliteType = (col: MetadataColumnDefinition): string => {
      switch (col.columnType) {
        case "integer": return "INTEGER";
        case "real": return "REAL";
        case "boolean": return "INTEGER";
        default: return "TEXT";
      }
    };

    for (const col of columns) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${sqliteType(col)}`); } catch { /* exists */ }
    }
    for (const [colName, colType] of [
      [`${prefix}_input_hash`, "TEXT"],
      [`${prefix}_generator_version`, "INTEGER"],
    ] as const) {
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colType}`); } catch { /* exists */ }
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
        `Metadata table for type "${targetType}" / generator "${entry.generatorId}" not registered.`,
      );
    }

    const columnNames: string[] = ["target_id"];
    const values: unknown[] = [entry.targetId];

    for (const col of generatorEntry.columns) {
      columnNames.push(col.name);
      values.push(entry.value[snakeToCamel(col.name)] ?? null);
    }

    columnNames.push(`${prefix}_input_hash`, `${prefix}_generator_version`);
    values.push(entry.inputHash, entry.generatorVersion);

    const placeholders = columnNames.map(() => "?").join(", ");
    const updateCols = columnNames.filter((c) => c !== "target_id");
    const updates = updateCols.map((c) => `${c} = excluded.${c}`).join(", ");
    const sql = `INSERT INTO ${table} (${columnNames.join(", ")}) VALUES (${placeholders}) ON CONFLICT(target_id) DO UPDATE SET ${updates}`;
    this.getDb().run(sql, values as string[]);
  }

  async queryMetadata(targetType: string, query: MetadataQuery): Promise<MetadataQueryResult> {
    const registered = this.metadataRegistry.get(targetType) ?? [];
    const { sql, params } = buildMetadataSelectQuery(targetType, query);
    const rows = this.getDb().query<Record<string, unknown>, unknown[]>(sql).all(params);
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
        if (inputHash === null || generatorVersion === null) continue;

        const value: Record<string, unknown> = {};
        for (const col of gen.columns) {
          value[snakeToCamel(col.name)] = row[col.name] ?? null;
        }
        entries.push({ targetId, generatorId: gen.generatorId, generatorVersion, inputHash, value });
      }
    }

    return { entries };
  }
}
