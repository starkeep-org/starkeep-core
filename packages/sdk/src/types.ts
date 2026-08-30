import type {
  StarkeepId,
  DataRecord,
  HLCClock,
  CreateDataRecordInput,
  MetadataRow,
  RecordLabel,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { IndexQuery, IndexResult } from "@starkeep/query-orchestrator";
import type {
  ChangeNotifier,
  SyncStateStore,
} from "@starkeep/sync-engine";
import type {
  ApiRequest,
  ApiResponse,
  ApiRouter,
  ApiSubject,
  AppSpecificOperations,
  WebSocketConnection,
} from "@starkeep/shared-space-api";

/**
 * Input to `data.putWithFile` / `data.putWithLocalFile` — the file-bytes /
 * content-hash / object-storage-key / size / mimeType are filled in by the
 * SDK from the supplied bytes, so callers only specify the metadata they
 * choose explicitly.
 */
export type DataPutInput = Omit<
  CreateDataRecordInput,
  "contentHash" | "objectStorageKey" | "mimeType" | "sizeBytes"
> & {
  /**
   * Optional per-category metadata row written alongside the records-table
   * row. Columns are defined by the record's category entry in `CATEGORIES`
   * (category = `typeCategory(type)`); `other` records have no metadata table.
   * The SDK supplies the `recordId` itself — callers omit it.
   *
   * **Not atomic with the record write.** The SDK issues `put` and
   * `putMetadata` as two sequential adapter calls, each its own transaction
   * (on DSQL, its own `withOccRetry`); over HTTP they are not even one
   * request, since metadata has its own endpoint. A reader can therefore
   * observe the record before its metadata row. Readers must tolerate that —
   * a record arriving at a peer without its dimensions is already normal,
   * since sync ships the two independently.
   */
  metadata?: Omit<MetadataRow, "recordId">;
};

export interface DataOperations {
  putWithFile(
    input: DataPutInput,
    file: Uint8Array,
    contentType?: string | null,
  ): Promise<DataRecord>;
  putWithLocalFile(
    input: DataPutInput,
    filePath: string,
    contentType?: string | null,
  ): Promise<DataRecord>;
  /**
   * Write a record for a blob that has already been placed in object storage
   * (e.g. via a presigned PUT upload). The caller supplies the content hash,
   * the resulting object-storage key, the byte length, and the mime type;
   * the SDK does not re-read the bytes. Use this when the upload path is
   * external to the SDK (e.g. browser → S3 → cloud-data-server confirm).
   */
  putWithExistingBlob(
    input: DataPutInput,
    blob: {
      contentHash: string;
      objectStorageKey: string;
      sizeBytes: number;
      mimeType?: string | null;
    },
  ): Promise<DataRecord>;
  get(recordId: StarkeepId): Promise<DataRecord | null>;
  // No `update`. The two fields one ever patched — `originalFilename` and
  // `parentId` — are identity now: `createDataRecord` content-addresses a
  // record's id from `(parent_id, original_filename, content_hash)`, so writing
  // either one in place leaves a row whose id no longer names its own content.
  // The next node to produce that same file mints the id the row should have
  // had, the uniqueness index refuses it, and the app's sync wedges — the
  // failure `identifiers/content-id.ts` exists to remove. Renaming a record
  // would have to re-key it, which is a delete plus a create and takes the
  // record's labels, children and history with it. See
  // `~/projects/starkeep/sync-duplicate-derivation-wedge-2026-08-29.md`.
  delete(recordId: StarkeepId): Promise<void>;
  query(params: { type?: string; filters?: import("@starkeep/storage-adapter").Filter[] }): Promise<DataRecord[]>;

  /**
   * Write a per-type metadata row, upserting the columns it names and leaving
   * the rest alone, then **bump the record's `updatedAt`**.
   *
   * The bump is what makes the write visible to sync at all: metadata rides the
   * record row over the wire, and the outbound scan is a delta scan over
   * `updated_at`. `version` is untouched — a derived fact arriving is not a new
   * revision of the record.
   *
   * The sync apply path must not use this. It writes through the database
   * adapter directly, because bumping on apply would make every applied row a
   * fresh change to ship back.
   */
  putMetadata(typeId: string, row: MetadataRow): Promise<void>;
  /** Read a per-type metadata row by recordId. */
  getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null>;
  /** Batch-read per-type metadata rows. */
  getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>>;

  // ---- Cross-app record labels -------------------------------------------
  //
  // ## Why `appId` is a parameter here
  //
  // This SDK is a **per-node** facility, not a per-app one: it has no app
  // identity of its own, and every write that needs one already takes it
  // explicitly (`CreateDataRecordInput.originAppId`). So the labelling app id
  // is a parameter, exactly as `originAppId` is.
  //
  // That means the "an app cannot name another namespace" guarantee is *not*
  // enforced by these types — it is enforced at the two data servers, which
  // set `app_id` from the authenticated subject and ignore anything the
  // request body says. This layer sits below that boundary, in the same way
  // `query()` here does no grant filtering while the servers do. Callers
  // reaching these methods directly are already inside the trust boundary.
  //
  // Likewise, the manifest declared-key check lives at the servers, which can
  // read `shared.app_label_keys`; these methods validate key and value
  // *shape* only.

  /**
   * Add labels in `appId`'s namespace. Idempotent per
   * `(recordId, appId, key, value)` — which is to say **it adds, it does not
   * replace**: a key is set-valued, so setting `faces=Bob` on a photo that
   * already carries `faces=Alice` leaves both. To make one key hold exactly a
   * given set of values — including the single-valued case, "set the count to
   * 4" — use {@link replaceLabelValues}, which is the only call that removes
   * what it did not write.
   *
   * **Owns the chunking at every size**, so there is no bulk/non-bulk split
   * and no cliff where a caller's hand-rolled loop quietly stops being the
   * right shape — the one-record case is a batch of one. DSQL caps a
   * transaction at 3,000 modified rows; this splits accordingly, and the
   * splits are **not** atomic with each other, so a failure partway leaves
   * earlier chunks written. That is safe to retry: the upsert is idempotent.
   *
   * Chunking is on **rows**, not records: a record contributes as many rows as
   * the caller gave it values, so rows-per-record is no longer fixed.
   *
   * An omitted `value` sets a bare flag, which is stored as the empty string.
   */
  setLabels(appId: string, entries: LabelSetEntry[]): Promise<void>;

  /**
   * Make `key` hold exactly `values` on each record: add the ones missing,
   * retract the ones present and absent from the list, atomically per record.
   *
   * This is the call an app wants whenever it thinks of a key as *its current
   * answer* rather than as an accumulating set — a single-valued key like
   * `quality=high`, or a re-run of a face detector that dropped a name. Written
   * as {@link setLabels} instead, the stale values stay, and the key reads back
   * as both answers at once with nothing to signal which is current.
   *
   * An empty `values` retracts the key entirely.
   */
  replaceLabelValues(appId: string, entries: LabelValuesEntry[]): Promise<void>;

  /**
   * Retract labels in `appId`'s namespace, as tombstones so the retraction
   * itself syncs. Takes the same entry shape as `setLabels`, so retraction
   * mirrors the write rather than being a convention to remember.
   *
   * An **omitted `value` retracts every value of that key** on that record —
   * the reading that keeps `{recordId, key}` meaning "take this assertion
   * back". Pass `value: ""` to retract a bare flag specifically.
   */
  retractLabels(appId: string, entries: LabelRetractEntry[]): Promise<void>;

  /**
   * All live labels on each of `recordIds`, from **every** app — one batched
   * query, the shape `?include=labels` uses. Ids with no labels are absent
   * from the map.
   */
  getLabelsByIds(recordIds: StarkeepId[]): Promise<Map<StarkeepId, RecordLabel[]>>;

  /**
   * Records carrying a given app's label. The query labels exist for: it is
   * what replaces "ask app A about every file".
   *
   * `sel.value` omitted means **presence** (any value, flags included);
   * supplied means exact match, and `""` specifically matches bare flags.
   * Callers reading this off a query string must tell an absent parameter from
   * an empty one — see `FindByLabelQuery.value`.
   *
   * > **Page until `nextCursor` is null.** A short page does not mean the end
   * > of the results — a label whose record was concurrently deleted drops out
   * > of its page. Only a null `nextCursor` means there is no more. Stopping
   * > on the first short page silently misses matches, and does so only under
   * > load, which is worse than an obvious bug.
   *
   * Results come back in the reverse index's own order and no other; sorting
   * by `created_at` would need a different index and is deliberately not
   * offered. The cursor is opaque — do not parse it.
   *
   * Note this does **not** filter by any caller's read grants (see the note
   * above about where the trust boundary is). The data servers apply that.
   */
  findByLabel(
    sel: { appId: string; key: string; value?: string },
    page?: { limit?: number; cursor?: string },
  ): Promise<{ records: DataRecord[]; nextCursor: string | null }>;
}

export interface LabelSetEntry {
  recordId: StarkeepId;
  key: string;
  /** Omitted sets a bare flag, stored as `""`. Never null. */
  value?: string;
}

export interface LabelValuesEntry {
  recordId: StarkeepId;
  key: string;
  /** The complete set this key should hold. Empty retracts the key. */
  values: string[];
}

export interface LabelRetractEntry {
  recordId: StarkeepId;
  key: string;
  /** Omitted retracts **every** value of this key on this record. */
  value?: string;
}

export interface IndexOperations {
  search(query: IndexQuery): Promise<IndexResult>;
}

export interface ApiOperations {
  readonly router: ApiRouter;
  handleRequest(request: ApiRequest): Promise<ApiResponse>;
  handleWebSocketConnect(connection: WebSocketConnection): () => void;
}

export type { ApiRouter };
export type { WebSocketConnection };

export interface StarkeepSdk {
  readonly data: DataOperations;
  readonly index: IndexOperations;
  readonly api: ApiOperations;
  /**
   * Broadcast channel for record-level events. The SDK emits
   * `local-change-recorded` on every write; the sync supervisor forwards
   * `local-data-synced` from its per-app engines onto this same notifier so
   * subscribers (sharedSpaceApi, SSE clients) see one unified stream.
   */
  readonly changeNotifier: ChangeNotifier;
  /** The clock backing this SDK — exposed so the supervisor can share it. */
  readonly clock: HLCClock;
  close(): Promise<void>;
}

export interface StarkeepSdkOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly nodeId: string;
  readonly clock?: HLCClock;
  /**
   * Optional state store. The SDK uses it only to seed and persist HLC clock
   * state (one clock per node). Per-app watermarks are owned by the
   * supervisor and never touched here.
   */
  readonly syncStateStore?: SyncStateStore;
  /**
   * Optional change-notifier to inject. When omitted the SDK creates its own.
   * Callers inject when they want a sibling component (e.g. the local-data-
   * server's app-specific factory) to emit `local-change-recorded` events
   * onto the same channel the supervisor subscribes to.
   */
  readonly changeNotifier?: ChangeNotifier;
  /**
   * Factory for the app-scoped app-specific operations exposed on the
   * ApiContext. Provided by the harness (local-data-server) since it owns
   * the syncable-namespace registry and storage layout.
   */
  readonly getAppSpecific?: (subject: ApiSubject) => AppSpecificOperations | null;
}
