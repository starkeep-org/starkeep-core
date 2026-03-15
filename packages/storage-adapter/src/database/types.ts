import type { AnyRecord, StarkeepId } from "@starkeep/core";

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
  kind?: "data" | "metadata";
  filters?: Filter[];
  sort?: SortField[];
  limit?: number;
  cursor?: string;
}

export interface QueryResult {
  records: AnyRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type BatchOperation =
  | { type: "put"; record: AnyRecord }
  | { type: "delete"; id: StarkeepId };

export interface Migration {
  version: number;
  name: string;
  up: (transaction: Transaction) => void | Promise<void>;
}

export interface Transaction {
  put(record: AnyRecord): Promise<void>;
  get(id: StarkeepId): Promise<AnyRecord | null>;
  delete(id: StarkeepId): Promise<void>;
  query(query: Query): Promise<QueryResult>;
}
