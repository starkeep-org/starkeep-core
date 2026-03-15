import type { AnyRecord, StarkeepId } from "@starkeep/core";
import type { Query, QueryResult, BatchOperation, Migration, Transaction } from "./types.js";

export interface DatabaseAdapter {
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;

  put(record: AnyRecord): Promise<void>;
  get(id: StarkeepId): Promise<AnyRecord | null>;
  delete(id: StarkeepId): Promise<void>;
  query(query: Query): Promise<QueryResult>;
  batch(operations: BatchOperation[]): Promise<void>;
  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>;

  runMigrations(migrations: Migration[]): Promise<void>;
}
