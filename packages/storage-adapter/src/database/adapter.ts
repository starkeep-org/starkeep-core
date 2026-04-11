import type { DataRecord, MetadataRecord, StarkeepId } from "@starkeep/core";
import type {
  Query,
  QueryResult,
  BatchOperation,
  Migration,
  Transaction,
  MetadataColumnDefinition,
  MetadataQuery,
  MetadataQueryResult,
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

  runMigrations(migrations: Migration[]): Promise<void>;

  /**
   * Ensure a per-type metadata table exists with columns for the given generator.
   * Called at SDK init for each registered generator and its input types.
   * Safe to call multiple times (idempotent).
   */
  ensureMetadataTable(
    targetType: string,
    generatorId: string,
    columns: MetadataColumnDefinition[],
  ): Promise<void>;

  /**
   * Upsert a metadata entry for a data record into the appropriate per-type
   * metadata table. Only the columns belonging to `entry.generatorId` are
   * written; other generators' columns in the same row are left untouched.
   */
  putMetadata(targetType: string, entry: MetadataRecord): Promise<void>;

  /**
   * Query entries from the per-type metadata table for `targetType`.
   * Returns one MetadataRecord per (target, generator) pair that matches.
   */
  queryMetadata(targetType: string, query: MetadataQuery): Promise<MetadataQueryResult>;
}
