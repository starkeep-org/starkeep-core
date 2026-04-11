import type { Query, Filter, SortField, MetadataQuery, MetadataColumnDefinition } from "@starkeep/storage-adapter";

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

/** Convert camelCase to snake_case for metadata column lookups. */
export function camelToSnake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase();
}

/** Convert snake_case to camelCase for metadata value reconstruction. */
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Sanitize a generator ID to a safe SQL identifier prefix. */
export function generatorIdToPrefix(generatorId: string): string {
  return generatorId
    .replace(/^@/, "")
    .replace(/[/:@\-]/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Derive the metadata table name for a given data record type. */
export function metadataTableName(targetType: string): string {
  const sanitized = targetType
    .replace(/^@/, "")
    .replace(/[/:@\-]/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "");
  return `metadata_${sanitized}`;
}

export interface BuiltMetadataQuery {
  sql: string;
  params: unknown[];
}

export function buildMetadataSelectQuery(
  targetType: string,
  query: MetadataQuery,
  registeredGenerators: Array<{ generatorId: string; columns: MetadataColumnDefinition[] }>,
): BuiltMetadataQuery {
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

  let sql = `SELECT * FROM ${table}`;
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  return { sql, params };
}
