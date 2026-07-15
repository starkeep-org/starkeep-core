import type { Query } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type ExpressionBuilder,
  type SelectQueryBuilder,
} from "kysely";

// External (camelCase) → column name (snake_case). Unknown fields pass through.
const FIELD_MAP: Record<string, string> = {
  id: "id",
  type: "type",
  createdAt: "created_at",
  updatedAt: "updated_at",
  deletedAt: "deleted_at",
  version: "version",
  contentHash: "content_hash",
  objectStorageKey: "object_storage_key",
  mimeType: "mime_type",
  sizeBytes: "size_bytes",
  originAppId: "origin_app_id",
  parentId: "parent_id",
  originalFilename: "original_filename",
  label: "label",
};

function mapField(field: string): string {
  return FIELD_MAP[field] ?? field;
}

// Single dynamic-schema Kysely instance used only to compile SQL — never
// executes. The DummyDriver lets us reuse Kysely's compiler without pulling
// in a real connection. `any` keeps it dialect-agnostic at the row level;
// column names are validated against the live SQLite schema at runtime.
export type DB = Record<string, Record<string, unknown>>;
export const compiler = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

export function buildSelectQuery(query: Query): BuiltQuery {
  type Qb = SelectQueryBuilder<DB, "shared_records", unknown>;
  let qb = compiler.selectFrom("shared_records").selectAll() as Qb;

  if (query.type) {
    qb = qb.where("type", "=", query.type);
  }

  if (query.filters) {
    for (const filter of query.filters) {
      qb = applyFilter(qb, filter);
    }
  }

  if (query.cursor) {
    qb = qb.where("id", ">", query.cursor);
  }

  if (query.sort && query.sort.length > 0) {
    for (const s of query.sort) {
      qb = qb.orderBy(mapField(s.field), s.direction === "desc" ? "desc" : "asc");
    }
  } else {
    qb = qb.orderBy("id", "asc");
  }

  if (query.limit) {
    qb = qb.limit(query.limit + 1); // +1 to detect hasMore
  }

  const compiled = qb.compile();
  return { sql: compiled.sql, params: [...compiled.parameters] };
}

function applyFilter<Qb extends SelectQueryBuilder<DB, "shared_records", unknown>>(
  qb: Qb,
  filter: { field: string; operator: string; value?: unknown },
): Qb {
  const col = mapField(filter.field);
  switch (filter.operator) {
    case "eq": return qb.where(col, "=", filter.value) as Qb;
    case "neq": return qb.where(col, "!=", filter.value) as Qb;
    case "gt": return qb.where(col, ">", filter.value) as Qb;
    case "gte": return qb.where(col, ">=", filter.value) as Qb;
    case "lt": return qb.where(col, "<", filter.value) as Qb;
    case "lte": return qb.where(col, "<=", filter.value) as Qb;
    case "in": return qb.where(col, "in", filter.value as unknown[]) as Qb;
    case "like": return qb.where(col, "like", `%${filter.value}%`) as Qb;
    case "isNull":
      return qb.where((eb: ExpressionBuilder<DB, "shared_records">) => eb(col, "is", null)) as Qb;
    case "isNotNull":
      return qb.where((eb: ExpressionBuilder<DB, "shared_records">) => eb(col, "is not", null)) as Qb;
    default: return qb;
  }
}
