import type {
  DataRecord,
  HLCTimestamp,
  MetadataRow,
  RecordLabel,
  StarkeepId,
} from "@starkeep/protocol-primitives";
import type {
  Query,
  QueryResult,
  BatchOperation,
  Transaction,
  LabelUpsert,
  LabelRetraction,
  FindByLabelQuery,
  FindByLabelResult,
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

  // ---- Cross-app record labels -------------------------------------------
  //
  // `appId` is never a parameter the *caller* chooses freely: both data servers
  // pass the authenticated subject. See records/labels.ts in
  // protocol-primitives for the model.

  /**
   * Insert-or-update label rows. Idempotent by primary key
   * `(record_id, app_id, key)`, so a replayed batch is harmless — which is what
   * makes it safe under DSQL's OCC retry with no read-modify-write round trip.
   *
   * Implementations must issue this as **one multi-row statement**, not a loop
   * of single writes: DSQL caps a transaction at 3,000 modified rows, and the
   * chunking that respects that cap is the caller's (the SDK's) job.
   *
   * Must not touch the `shared.records` row. A label write that bumped
   * `records.updated_at` would re-ship the whole record over the Drive channel
   * and disturb every peer's watermark.
   */
  upsertLabels(labels: LabelUpsert[]): Promise<void>;

  /**
   * Retract labels by stamping `deleted_at`. A tombstone, not a hard delete,
   * so the retraction itself syncs. Scoped by primary key — which contains
   * `app_id` — so an app can only ever retract its own rows.
   */
  retractLabels(retractions: LabelRetraction[]): Promise<void>;

  /**
   * Forward path: every live label on each of `recordIds`, keyed by record id.
   * A primary-key prefix seek with an IN-list — the same shape
   * `?include=metadata` already uses. Ids with no labels are absent from the
   * map rather than mapping to an empty array.
   */
  getLabelsByRecordIds(recordIds: StarkeepId[]): Promise<Map<StarkeepId, RecordLabel[]>>;

  /**
   * Reverse path: which records a given app labelled with a given key. The
   * query labels exist for.
   *
   * Results come back in the reverse index's own order, `(value, record_id)`,
   * and the cursor encodes that composite rather than a bare record id — see
   * {@link FindByLabelQuery.cursor}.
   */
  findByLabel(query: FindByLabelQuery): Promise<FindByLabelResult>;

  /**
   * Tombstone every label on a record, whatever app wrote it. The record-delete
   * cascade: DSQL has no FKs, so this is done in application code.
   *
   * **Platform operation, not an app write.** It crosses app namespaces, so it
   * must not be reachable from `/data/*` — an app deleting a record it owns is
   * allowed to retract other apps' assertions about that record, but only
   * because the record is going away.
   */
  tombstoneLabelsForRecord(recordId: StarkeepId, hlc: HLCTimestamp): Promise<void>;
}
