import type { DataRecord, HLCTimestamp, StarkeepId } from "@starkeep/protocol-primitives";

export type SortDirection = "asc" | "desc";

export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "like"
  | "isNull"
  | "isNotNull";

export interface Filter {
  field: string;
  operator: FilterOperator;
  /** Ignored for `isNull` and `isNotNull`. */
  value?: unknown;
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
  | { type: "delete"; id: StarkeepId; hlc: HLCTimestamp };

export interface Transaction {
  put(record: DataRecord): Promise<void>;
  get(id: StarkeepId): Promise<DataRecord | null>;
  delete(id: StarkeepId, hlc: HLCTimestamp): Promise<void>;
  query(query: Query): Promise<QueryResult>;
}

