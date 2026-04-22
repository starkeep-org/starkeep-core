import type { Query, MetadataQuery, MetadataColumnDefinition } from "@starkeep/storage-adapter";

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

function mapField(field: string, parameterIndex: { value: number }): string {
  if (field.startsWith("content.")) {
    const jsonKey = field.slice("content.".length);
    return `(content::json)->>'${jsonKey}'`;
  }
  return FIELD_MAP[field] ?? field;
}

export interface BuiltPostgresQuery {
  text: string;
  values: unknown[];
}

export function buildPostgresQuery(query: Query): BuiltPostgresQuery {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let parameterIndex = 1;

  if (query.type) {
    conditions.push(`type = $${parameterIndex}`);
    values.push(query.type);
    parameterIndex++;
  }

  if (query.filters) {
    for (const filter of query.filters) {
      const column = mapField(filter.field, { value: parameterIndex });
      switch (filter.operator) {
        case "eq":
          conditions.push(`${column} = $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "neq":
          conditions.push(`${column} != $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "gt":
          conditions.push(`${column} > $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "gte":
          conditions.push(`${column} >= $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "lt":
          conditions.push(`${column} < $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "lte":
          conditions.push(`${column} <= $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "in": {
          const filterValues = filter.value as unknown[];
          const placeholders = filterValues.map(() => {
            const placeholder = `$${parameterIndex}`;
            parameterIndex++;
            return placeholder;
          });
          conditions.push(`${column} IN (${placeholders.join(", ")})`);
          values.push(...filterValues);
          break;
        }
        case "like":
          conditions.push(`${column} LIKE $${parameterIndex}`);
          values.push(`%${filter.value}%`);
          parameterIndex++;
          break;
      }
    }
  }

  if (query.cursor) {
    conditions.push(`id > $${parameterIndex}`);
    values.push(query.cursor);
    parameterIndex++;
  }

  let text = "SELECT * FROM records";
  if (conditions.length > 0) {
    text += ` WHERE ${conditions.join(" AND ")}`;
  }

  if (query.sort && query.sort.length > 0) {
    const orderClauses = query.sort.map(
      (sortField) =>
        `${mapField(sortField.field, { value: 0 })} ${sortField.direction === "desc" ? "DESC" : "ASC"}`,
    );
    text += ` ORDER BY ${orderClauses.join(", ")}`;
  } else {
    text += " ORDER BY id ASC";
  }

  if (query.limit) {
    text += ` LIMIT $${parameterIndex}`;
    values.push(query.limit + 1); // +1 to detect hasMore
    parameterIndex++;
  }

  return { text, values };
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

export function buildPostgresMetadataQuery(
  targetType: string,
  query: MetadataQuery,
): BuiltPostgresQuery {
  const table = metadataTableName(targetType);
  const conditions: string[] = [];
  const values: unknown[] = [];
  let parameterIndex = 1;

  if (query.targetId) {
    conditions.push(`target_id = $${parameterIndex}`);
    values.push(query.targetId);
    parameterIndex++;
  } else if (query.targetIds && query.targetIds.length > 0) {
    const placeholders = query.targetIds.map(() => {
      const p = `$${parameterIndex}`;
      parameterIndex++;
      return p;
    });
    conditions.push(`target_id IN (${placeholders.join(", ")})`);
    values.push(...query.targetIds);
  }

  if (query.filters) {
    for (const filter of query.filters) {
      const column = camelToSnake(filter.field);
      switch (filter.operator) {
        case "eq":
          conditions.push(`${column} = $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "neq":
          conditions.push(`${column} != $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "gt":
          conditions.push(`${column} > $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "gte":
          conditions.push(`${column} >= $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "lt":
          conditions.push(`${column} < $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "lte":
          conditions.push(`${column} <= $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "in": {
          const filterValues = filter.value as unknown[];
          const placeholders = filterValues.map(() => {
            const p = `$${parameterIndex}`;
            parameterIndex++;
            return p;
          });
          conditions.push(`${column} IN (${placeholders.join(", ")})`);
          values.push(...filterValues);
          break;
        }
        case "like":
          conditions.push(`${column} LIKE $${parameterIndex}`);
          values.push(`%${filter.value}%`);
          parameterIndex++;
          break;
      }
    }
  }

  let text = `SELECT * FROM ${table}`;
  if (conditions.length > 0) {
    text += ` WHERE ${conditions.join(" AND ")}`;
  }

  return { text, values };
}
