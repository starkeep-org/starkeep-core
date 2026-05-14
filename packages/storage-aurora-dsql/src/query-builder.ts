import type { Query } from "@starkeep/storage-adapter";

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
  originAppId: "origin_app_id",
  parentId: "parent_id",
};

function mapField(field: string): string {
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
      const column = mapField(filter.field);
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
        `${mapField(sortField.field)} ${sortField.direction === "desc" ? "DESC" : "ASC"}`,
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
