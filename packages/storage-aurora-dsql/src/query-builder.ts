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
export type DB = Record<string, Record<string, unknown>>;
export const compiler = new Kysely<DB>({
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

  if (query.excludeLabel) {
    // NOT EXISTS rather than a LEFT JOIN … IS NULL: a record can carry several
    // values of one key, and a join would multiply its row before the null
    // test, so the record would come back once per *other* label it holds.
    // The tombstone check is not optional — a retracted rendition label means
    // the record is no longer a rendition, and treating the dead row as live
    // would permanently hide it from the grid.
    const { appId, key } = query.excludeLabel;
    qb = qb.where((eb: ExpressionBuilder<DB, typeof TABLE>) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("shared.record_labels")
            .select("record_id")
            .whereRef("shared.record_labels.record_id", "=", "shared.records.id")
            .where("app_id", "=", appId)
            .where("key", "=", key)
            .where("deleted_at", "is", null),
        ),
      ),
    ) as Qb;
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
