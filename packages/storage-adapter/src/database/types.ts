import type { DataRecord, MetadataRecord, StarkeepId } from "@starkeep/core";

export type SortDirection = "asc" | "desc";

export interface Filter {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "like";
  value: unknown;
}

export interface SortField {
  field: string;
  direction: SortDirection;
}

export interface Query {
  type?: string;
  filters?: Filter[];
  sort?: SortField[];
  limit?: number;
  cursor?: string;
}

export interface QueryResult {
  records: DataRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type BatchOperation =
  | { type: "put"; record: DataRecord }
  | { type: "delete"; id: StarkeepId };

export interface Migration {
  version: number;
  name: string;
  up: (transaction: Transaction) => void | Promise<void>;
}

export interface Transaction {
  put(record: DataRecord): Promise<void>;
  get(id: StarkeepId): Promise<DataRecord | null>;
  delete(id: StarkeepId): Promise<void>;
  query(query: Query): Promise<QueryResult>;
}

/**
 * Defines one SQL column produced by a generator. Column names use snake_case;
 * values in MetadataRecord.value use the corresponding camelCase key.
 */
export interface MetadataColumnDefinition {
  /** Snake_case SQL column name, e.g. "group_id", "comment_count". */
  readonly name: string;
  readonly columnType: "text" | "integer" | "real" | "boolean";
}

export interface MetadataQuery {
  targetId?: StarkeepId;
  targetIds?: StarkeepId[];
  /** When specified, only return entries produced by this generator. */
  generatorId?: string;
  /** Field filters on generator output columns (use camelCase field names). */
  filters?: Filter[];
}

export interface MetadataQueryResult {
  entries: MetadataRecord[];
}
