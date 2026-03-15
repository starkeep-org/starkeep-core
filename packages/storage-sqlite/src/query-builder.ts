import type { Query, Filter, SortField } from "@starkeep/storage-adapter";

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

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

export function buildSelectQuery(query: Query): BuiltQuery {
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
      (sortField) => `${mapField(sortField.field)} ${sortField.direction === "desc" ? "DESC" : "ASC"}`,
    );
    sql += ` ORDER BY ${orderClauses.join(", ")}`;
  } else {
    sql += " ORDER BY id ASC";
  }

  if (query.limit) {
    sql += ` LIMIT ?`;
    params.push(query.limit + 1); // +1 to detect hasMore
  }

  return { sql, params };
}
