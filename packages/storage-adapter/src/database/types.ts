import type { DataRecord, MetadataRecord, StarkeepId, HLCTimestamp } from "@starkeep/core";

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

/**
 * A metadata record that participates in sync. Stored in the `metadata_sync`
 * table alongside the per-type typed-column metadata tables.
 *
 * `targetType` is included (unlike `MetadataRecord`) so the sync engine can
 * route the record back to the correct per-type table when applying remote
 * changes. `inputHash` is nullable to accommodate user-authored entries where
 * the value is written directly rather than derived from a data record.
 *
 * File-backed metadata (e.g. image downsizes) stores the generated file in
 * object storage. `objectStorageKey` references the file using the same flat
 * content-addressed scheme as `DataRecord` (SHA-256 hex). The sync engine
 * transfers these files alongside the metadata records.
 */
export interface MetadataSyncRecord {
  readonly targetId: StarkeepId;
  readonly targetType: string;
  readonly generatorId: string;
  generatorVersion: number;
  inputHash: string | null;
  updatedAt: HLCTimestamp;
  value: Record<string, unknown>;
  objectStorageKey?: string | null;
  contentHash?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
}
