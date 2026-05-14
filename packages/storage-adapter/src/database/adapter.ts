import type { DataRecord, StarkeepId } from "@starkeep/core";
import type {
  Query,
  QueryResult,
  BatchOperation,
  Transaction,
} from "./types.js";

export interface DatabaseAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;

  put(record: DataRecord): Promise<void>;
  get(id: StarkeepId): Promise<DataRecord | null>;
  delete(id: StarkeepId): Promise<void>;
  query(query: Query): Promise<QueryResult>;
  batch(operations: BatchOperation[]): Promise<void>;
  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>;
}
