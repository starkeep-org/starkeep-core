import type { DataRecord, HLCTimestamp, MetadataRow, StarkeepId } from "@starkeep/protocol-primitives";
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
  /**
   * Soft-delete: stamps `deleted_at` and bumps `updated_at` to `hlc`.
   * The row remains so sync deltas can see the tombstone.
   * No-op if the row does not exist.
   */
  delete(id: StarkeepId, hlc: HLCTimestamp): Promise<void>;
  query(query: Query): Promise<QueryResult>;

  /**
   * Per-nodeId MAX(updated_at) over every stored row (tombstones included) —
   * the responder-side summary the sync exchange reports as its coverage
   * watermark. SQL adapters back this with the denormalized `node_id` column
   * + `(node_id, updated_at)` index so it doesn't scan the table.
   */
  getNodeWatermarks(): Promise<Record<string, HLCTimestamp>>;
  batch(operations: BatchOperation[]): Promise<void>;
  transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T>;

  /**
   * Write (insert-or-replace) the per-type metadata row keyed by `row.recordId`.
   * Caller is responsible for ensuring the corresponding records-table row
   * exists; we do not enforce FK at the DB level (Aurora DSQL doesn't support
   * FKs anyway) but a metadata row without its record is meaningless.
   */
  putMetadata(typeId: string, row: MetadataRow): Promise<void>;

  /** Read the per-type metadata row for `recordId`, or null if absent. */
  getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null>;

  /**
   * Batched read of per-type metadata rows. Returned map is keyed by recordId
   * and contains only ids that have a metadata row.
   */
  getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>>;

  /** Delete the per-type metadata row for `recordId` (no-op if absent). */
  deleteMetadata(typeId: string, recordId: StarkeepId): Promise<void>;
}
