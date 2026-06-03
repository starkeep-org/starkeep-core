import type { Query } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type ExpressionBuilder,
  type SelectQueryBuilder,
} from "kysely";

// External (camelCase) → column name (snake_case). Unknown fields pass through.
const FIELD_MAP: Record<string, string> = {
  id: "id",
  type: "type",
  createdAt: "created_at",
  updatedAt: "updated_at",
  ownerId: "owner_id",
  deletedAt: "deleted_at",
  version: "version",
  contentHash: "content_hash",
  objectStorageKey: "object_storage_key",
  mimeType: "mime_type",
  sizeBytes: "size_bytes",
  originAppId: "origin_app_id",
  parentId: "parent_id",
  originalFilename: "original_filename",
};

function mapField(field: string): string {
  return FIELD_MAP[field] ?? field;
}

// Compile-only Kysely instance (DummyDriver never executes). The dialect's
// PostgresQueryCompiler produces `$1`-style placeholders that `pg.Client`
// consumes directly.
type DB = Record<string, Record<string, unknown>>;
const compiler = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const TABLE = "shared.records";

export interface BuiltPostgresQuery {
  text: string;
  values: unknown[];
}

export function buildPostgresQuery(query: Query): BuiltPostgresQuery {
  type Qb = SelectQueryBuilder<DB, typeof TABLE, unknown>;
  let qb = compiler.selectFrom(TABLE).selectAll() as Qb;

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
  return { text: compiled.sql, values: [...compiled.parameters] };
}

function applyFilter<Qb extends SelectQueryBuilder<DB, typeof TABLE, unknown>>(
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
      return qb.where((eb: ExpressionBuilder<DB, typeof TABLE>) => eb(col, "is", null)) as Qb;
    case "isNotNull":
      return qb.where((eb: ExpressionBuilder<DB, typeof TABLE>) => eb(col, "is not", null)) as Qb;
    default: return qb;
  }
}
