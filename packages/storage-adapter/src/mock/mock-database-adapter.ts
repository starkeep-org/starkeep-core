import type {
  DataRecord,
  HLCTimestamp,
  MetadataRow,
  RecordLabel,
  StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  compareHLC,
  isKnownType,
  serializeHLC,
  typeCategory,
  METADATA_DISCRIMINANT_COLUMN,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "../database/adapter.js";
import {
  mergeDigestBuckets,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DigestBucket,
} from "../database/digest-queries.js";
import { trimToHlcBoundary, type SincePage } from "../database/since-queries.js";
import {
  compareOrderKey,
  decodeQueryCursor,
  encodeQueryCursor,
  type QueryCursorKey,
} from "../database/query-cursor.js";
import { orderingFor } from "../database/record-queries.js";
import { matchesWhere, runInMemoryQuery } from "../database/app-query-memory.js";
import { labelToRow } from "../database/label-row.js";
import {
  sharedQuerySchema,
  sharedQueryExcludesSoftDeleted,
  type SharedQueryTarget,
} from "../database/shared-query-schemas.js";
import type {
  ParsedQuery,
  ParsedQueryResult,
  WhereClause,
} from "../database/app-query-types.js";
import type {
  Query,
  QueryResult,
  BatchOperation,
  Transaction,
  LabelUpsert,
  LabelRetraction,
  LabelValueReplacement,
  FindByLabelQuery,
  FindByLabelResult,
  StoredAvailability,
  RecordTypeCount,
} from "../database/types.js";
import {
  encodeLabelScanCursor,
  decodeLabelScanCursor,
  compareLabelScanOrder,
  isAfterLabelScanCursor,
} from "../database/label-cursor.js";
import {
  emptyLabelPage,
  labelPageFrom,
  planFindByLabel,
  LABEL_QUERY_TARGET,
} from "../database/label-find.js";

export class MockDatabaseAdapter implements DatabaseAdapter {
  private store = new Map<string, DataRecord>();
  private metadata = new Map<string, Map<StarkeepId, MetadataRow>>();
  /** Keyed `<recordId> <appId> <key>` — the label primary key. */
  private labels = new Map<string, RecordLabel>();
  private initialized = false;

  async init(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  async healthCheck(): Promise<boolean> {
    return this.initialized;
  }

  async put(record: DataRecord): Promise<void> {
    this.store.set(record.id, structuredClone(record));
  }

  async get(id: StarkeepId): Promise<DataRecord | null> {
    const record = this.store.get(id);
    return record ? structuredClone(record) : null;
  }

  async delete(id: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    const existing = this.store.get(id);
    if (!existing) return;
    this.store.set(id, { ...existing, deletedAt: hlc, updatedAt: hlc });
  }

  async getNodeWatermarks(): Promise<Record<string, HLCTimestamp>> {
    // In-memory reference fold — the behavior SQL adapters implement with the
    // node_id column + (node_id, updated_at) index.
    const out: Record<string, HLCTimestamp> = {};
    for (const record of this.store.values()) {
      const hlc = record.updatedAt;
      const existing = out[hlc.nodeId];
      if (
        !existing ||
        hlc.wallTime > existing.wallTime ||
        (hlc.wallTime === existing.wallTime && hlc.counter > existing.counter)
      ) {
        out[hlc.nodeId] = hlc;
      }
    }
    return out;
  }

  /**
   * In-memory reference fold for the delta scan — the behaviour SQL adapters
   * get from per-author seeks on `(node_id, updated_at)`.
   *
   * Written the slow, obvious way on purpose: this is what the indexed
   * implementations are checked against, so it must be readable as a statement
   * of the contract rather than as a second optimization.
   */
  async querySince(
    peerWatermarks: Record<string, HLCTimestamp>,
    limit: number,
  ): Promise<SincePage<DataRecord>> {
    const owed = Array.from(this.store.values()).filter((r) =>
      isOwed(r.updatedAt, peerWatermarks),
    );
    return pageByNode<DataRecord>(owed, (r) => r.updatedAt, limit);
  }

  async queryLabelsSince(
    peerWatermarks: Record<string, HLCTimestamp>,
    limit: number,
  ): Promise<SincePage<RecordLabel>> {
    const owed = Array.from(this.labels.values()).filter((l) =>
      isOwed(l.updatedAt, peerWatermarks),
    );
    return pageByNode<RecordLabel>(owed, (l) => l.updatedAt, limit);
  }

  /** In-memory reference fold for the bucketed digest. */
  async bucketDigest(
    prefixLength: number = DEFAULT_BUCKET_PREFIX_LENGTH,
  ): Promise<DigestBucket[]> {
    const buckets: DigestBucket[] = [];
    const rows = [
      ...Array.from(this.store.values()).map((r) => r.updatedAt),
      ...Array.from(this.labels.values()).map((l) => l.updatedAt),
    ];
    for (const hlc of rows) {
      buckets.push({
        nodeId: hlc.nodeId,
        bucket: serializeHLC(hlc).slice(0, prefixLength),
        count: 1,
      });
    }
    return mergeDigestBuckets(buckets);
  }

  async query(query: Query): Promise<QueryResult> {
    let records = Array.from(this.store.values());

    if (query.type) {
      records = records.filter((record) => record.type === query.type);
    }
    if (query.filters) {
      for (const filter of query.filters) {
        records = records.filter((record) => {
          const parts = filter.field.split(".");
          let value: unknown = record;
          for (const part of parts) {
            value = (value as Record<string, unknown>)?.[part];
          }
          switch (filter.operator) {
            case "eq": return value === filter.value;
            case "neq": return value !== filter.value;
            case "gt": return (value as number) > (filter.value as number);
            case "gte": return (value as number) >= (filter.value as number);
            case "lt": return (value as number) < (filter.value as number);
            case "lte": return (value as number) <= (filter.value as number);
            case "in": return (filter.value as unknown[]).includes(value);
            case "like": return typeof value === "string" && value.includes(filter.value as string);
            // Soft deletion is expressed as `deletedAt isNull` by every caller
            // that means "live records only". Falling through to `true` here
            // made the mock return tombstoned records, so anything tested
            // against it — the whole SDK suite — was blind to deletion.
            case "isNull": return value === null || value === undefined;
            case "isNotNull": return value !== null && value !== undefined;
            default: return true;
          }
        });
      }
    }
    // The grammar's own predicates, evaluated by the one in-memory evaluator
    // the shared-plane path uses. Against a column view of the record, because
    // a `where` clause names a column and this store holds camelCase objects.
    if (query.where && query.where.length > 0) {
      const clauses = query.where;
      records = records.filter((record) => matchesWhere(recordToRow(record), clauses));
    }

    // The label anti-join, which this mock used to ignore entirely.
    //
    // Ignoring it made every test written against this adapter blind to the one
    // thing the filter exists for: a rendition is a child record, and a phone
    // holding a five-rung ladder per photograph has six records where a grid
    // must show one. A mock that answers a question the real adapters answer
    // differently is worse than one that refuses to answer it.
    if (query.excludeLabel) {
      const { appId, key } = query.excludeLabel;
      const excluded = new Set<string>();
      for (const label of this.labels.values()) {
        // The tombstone check is not optional — a retracted rendition label
        // means the record is no longer a rendition, and treating the dead row
        // as live would permanently hide it from the grid.
        if (label.appId === appId && label.key === key && !label.deletedAt) {
          excluded.add(label.recordId);
        }
      }
      records = records.filter((record) => !excluded.has(record.id));
    }

    // The same ordering the SQL adapters compile, spelled as a comparator:
    // every key null-normalized to sort nulls last, then the record id as the
    // total tiebreaker. Restating it here rather than sharing it would let the
    // in-memory adapter answer a different order from the real ones, which is
    // exactly the kind of divergence a mock exists to avoid.
    const ordering = orderingFor(query);
    records.sort((a, b) => {
      for (let i = 0; i < ordering.keys.length; i += 1) {
        const key = ordering.keys[i];
        const decided = compareOrderKey(
          this.orderKeyFor(a, key.field),
          this.orderKeyFor(b, key.field),
          key.direction,
        );
        if (decided !== 0) return decided;
      }
      if (a.id === b.id) return 0;
      const ascending = a.id < b.id ? -1 : 1;
      return ordering.idDirection === "desc" ? -ascending : ascending;
    });

    const limit = query.limit ?? records.length;
    // The cursor names a row, and the row's position in the sorted list is
    // where the next page starts. Locating it by id is equivalent to the SQL
    // keyset predicate and needs none of its machinery, because the whole
    // ordered set is in hand here.
    const cursorId = ordering.bareId
      ? query.cursor
      : query.cursor
        ? decodeQueryCursor(query.cursor, ordering.signature)?.id
        : undefined;
    const found = cursorId ? records.findIndex((record) => record.id === cursorId) : -1;
    // A cursor naming a row this query no longer returns — deleted, or filtered
    // out since it was handed over — starts from the beginning rather than from
    // an arbitrary place, which is what the SQL side's rejected-token path does.
    const cursorIndex = found === -1 ? 0 : found + 1;

    const sliced = records.slice(cursorIndex, cursorIndex + limit);
    const hasMore = cursorIndex + limit < records.length;
    const last = sliced[sliced.length - 1];

    return {
      records: sliced.map((record) => structuredClone(record)),
      nextCursor:
        hasMore && last
          ? ordering.bareId
            ? last.id
            : encodeQueryCursor({
                order: ordering.signature,
                keys: ordering.keys.map((key) => this.orderKeyFor(last, key.field)),
                id: last.id,
              })
          : null,
      hasMore,
    };
  }

  async countRecords(query: Query): Promise<number> {
    // Through `query` itself, with paging turned off, so the count cannot
    // disagree with the rows about what "matches" means.
    const { sort, limit, cursor, ...rest } = query;
    void sort;
    void limit;
    void cursor;
    const page = await this.query(rest);
    return page.records.length;
  }

  async countRecordsByType(query: Query): Promise<RecordTypeCount[]> {
    // Same route as `countRecords`: through `query` with paging off, so the
    // mock cannot disagree with itself about what "matches" means.
    const { sort, limit, cursor, ...rest } = query;
    void sort;
    void limit;
    void cursor;
    const page = await this.query(rest);
    const byType = new Map<string, { count: number; latestUpdatedAt: string | null }>();
    for (const record of page.records) {
      const updatedAt = serializeHLC(record.updatedAt);
      const existing = byType.get(record.type);
      if (!existing) {
        byType.set(record.type, { count: 1, latestUpdatedAt: updatedAt });
        continue;
      }
      existing.count += 1;
      if (existing.latestUpdatedAt === null || updatedAt > existing.latestUpdatedAt) {
        existing.latestUpdatedAt = updatedAt;
      }
    }
    return Array.from(byType.entries()).map(([type, info]) => ({ type, ...info }));
  }

  /**
   * One ordering key's value for a record, null-normalized.
   *
   * Three shapes, because the fields a caller can order by have three:
   * `capturedAt` lives in the per-category metadata rather than on the record,
   * an HLC column is an object that has to be serialized before it compares,
   * and everything else is already a scalar.
   */
  private orderKeyFor(record: DataRecord, field: string): QueryCursorKey {
    if (field === "capturedAt") {
      const category = typeCategory(record.type);
      const row = this.metadata.get(category)?.get(record.id);
      const value = row?.["captured_at"];
      const usable = typeof value === "string" || typeof value === "number" ? value : null;
      return { isNull: usable === null, value: usable };
    }
    const raw = (record as unknown as Record<string, unknown>)[field];
    if (raw && typeof raw === "object" && "wallTime" in raw) {
      // `createdAt` and `updatedAt` are HLC objects here and strings in the
      // database. Serializing is what makes the mock order them the way a real
      // adapter does, instead of comparing two objects and calling every pair
      // equal — which is what it used to do.
      return { isNull: false, value: serializeHLC(raw as HLCTimestamp) };
    }
    const usable =
      typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? raw : null;
    return { isNull: usable === null, value: usable };
  }

  /**
   * See `DatabaseAdapter.queryShared`. Evaluated in JavaScript by
   * `app-query-memory.ts` against the same parsed value the SQL adapters
   * compile, over a row-shaped view of whichever store the target names.
   *
   * The row view is not optional detail. The mock holds `DataRecord`,
   * `RecordLabel` and `MetadataRow` objects in camelCase, and every predicate a
   * caller writes names a *column*. Answering over the objects would make the
   * mock accept a grammar the real backends reject and reject one they accept.
   */
  async queryShared(
    target: SharedQueryTarget,
    query: ParsedQuery,
    options: { readonly serverWhere?: readonly WhereClause[] } = {},
  ): Promise<ParsedQueryResult> {
    // Asked for its side effect: an unknown category, or `other`, has no
    // metadata table and must fail here rather than answer an empty page.
    sharedQuerySchema(target);
    const rows = this.sharedRows(target);
    // The compiler applies the soft-delete predicate; nothing parses it, so it
    // is applied here for the two tables that carry the column.
    const live = sharedQueryExcludesSoftDeleted(target)
      ? rows.filter((row) => row["deleted_at"] === null || row["deleted_at"] === undefined)
      : rows;
    return runInMemoryQuery(live, query, options);
  }

  /** A column-shaped view of one shared table. */
  private sharedRows(target: SharedQueryTarget): Record<string, unknown>[] {
    if (target.kind === "labels") {
      return [...this.labels.values()].map((label) => ({ ...labelToRow(label) }));
    }
    if (target.kind === "metadata") {
      const table = this.metadata.get(target.category);
      if (!table) return [];
      return [...table.values()].map(({ recordId, ...columns }) => ({
        record_id: recordId as string,
        ...columns,
      }));
    }
    return [...this.store.values()].map(recordToRow);
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    for (const operation of operations) {
      if (operation.type === "put") {
        await this.put(operation.record);
      } else {
        await this.delete(operation.id, operation.hlc);
      }
    }
  }

  async transaction<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    const snapshot = new Map(this.store);
    try {
      const result = await callback(this as Transaction);
      return result;
    } catch (error) {
      this.store = snapshot;
      throw error;
    }
  }

  /**
   * Upsert the columns `row` names and leave every other column alone —
   * matching the `ON CONFLICT DO UPDATE SET <supplied columns>` both SQL
   * adapters compile.
   *
   * This used to replace the whole row, which made the mock the only backend
   * where writing one column erased the rest. The metadata a sync round carries
   * is deliberately partial (null columns are stripped before sending), so a
   * mock that replaced would have reported the merge working while the real
   * backends did something else.
   */
  async putMetadata(recordType: string, row: MetadataRow): Promise<void> {
    // A bare category is refused here as it is by both SQL adapters: the
    // discriminant written below gates every read of the row, so a caller
    // holding only a category has lost the thing this column exists to carry.
    if (!isKnownType(recordType)) {
      throw new Error(
        `putMetadata needs the record's own type, not "${recordType}": the ` +
          `${METADATA_DISCRIMINANT_COLUMN} column gates every read of this row`,
      );
    }
    const table = this.metadataTable(recordType);
    const existing = table.get(row.recordId);
    const incoming = structuredClone(row);
    // Server-set, never merged from the caller's row — see
    // METADATA_DISCRIMINANT_COLUMN.
    delete incoming[METADATA_DISCRIMINANT_COLUMN];
    table.set(row.recordId, {
      ...(existing ?? {}),
      ...incoming,
      [METADATA_DISCRIMINANT_COLUMN]: recordType,
      recordId: row.recordId,
    });
  }

  /**
   * Keyed by **category**, the way both SQL adapters key it: one table per
   * category, addressed by a type id or a category id alike
   * (`sqliteMetadataTableName` / `pgMetadataTableName` accept both). Keying by
   * the raw argument would let a write as `image/jpeg` and a read as `image`
   * miss each other, which no real backend does.
   */
  private metadataTable(typeOrCategory: string): Map<StarkeepId, MetadataRow> {
    const category = typeCategory(typeOrCategory);
    let table = this.metadata.get(category);
    if (!table) {
      table = new Map();
      this.metadata.set(category, table);
    }
    return table;
  }

  async getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null> {
    const row = this.metadataTable(typeId).get(recordId);
    return row ? structuredClone(row) : null;
  }

  async getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>> {
    const table = this.metadataTable(typeId);
    const result = new Map<StarkeepId, MetadataRow>();
    for (const id of recordIds) {
      const row = table.get(id);
      if (row) result.set(id, structuredClone(row));
    }
    return result;
  }

  async deleteMetadata(typeId: string, recordId: StarkeepId): Promise<void> {
    this.metadataTable(typeId).delete(recordId);
  }

  // ---- Cross-app record labels -------------------------------------------
  //
  // Keyed by the same `(recordId, appId, key)` primary key the SQL adapters
  // use, so the "two apps can never contend on one row" property is modelled
  // here too rather than being an accident of the store shape.

  private labelKey(recordId: string, appId: string, key: string, value: string): string {
    // JSON rather than a delimiter-joined string: `value` is arbitrary caller
    // text, so any separator character can make two distinct rows collide.
    return JSON.stringify([recordId, appId, key, value]);
  }

  async upsertLabels(labels: LabelUpsert[]): Promise<void> {
    for (const l of labels) {
      const k = this.labelKey(l.recordId, l.appId, l.key, l.value);
      const existing = this.labels.get(k);
      this.labels.set(k, {
        recordId: l.recordId,
        appId: l.appId,
        key: l.key,
        value: l.value,
        recordType: l.recordType,
        createdAt: existing?.createdAt ?? l.hlc,
        updatedAt: l.hlc,
        nodeId: l.hlc.nodeId,
        // Re-setting a retracted label revives it, matching the SQL adapters.
        deletedAt: null,
      });
    }
  }

  async retractLabels(retractions: LabelRetraction[]): Promise<void> {
    for (const r of retractions) {
      // An omitted value retracts every value of the key on that record, which
      // is why this scans rather than doing a single keyed lookup.
      for (const existing of this.labels.values()) {
        if (existing.recordId !== r.recordId) continue;
        if (existing.appId !== r.appId || existing.key !== r.key) continue;
        if (r.value !== undefined && existing.value !== r.value) continue;
        existing.deletedAt = r.hlc;
        existing.updatedAt = r.hlc;
        existing.nodeId = r.hlc.nodeId;
      }
    }
  }

  async replaceLabelValues(replacements: LabelValueReplacement[]): Promise<void> {
    for (const r of replacements) {
      const keep = new Set(r.values);
      // Tombstone the values that are going away, skipping rows already
      // tombstoned so a re-run does not restamp them with a later HLC.
      for (const existing of this.labels.values()) {
        if (existing.recordId !== r.recordId) continue;
        if (existing.appId !== r.appId || existing.key !== r.key) continue;
        if (keep.has(existing.value) || existing.deletedAt) continue;
        existing.deletedAt = r.hlc;
        existing.updatedAt = r.hlc;
        existing.nodeId = r.hlc.nodeId;
      }
      await this.upsertLabels(
        r.values.map((value: string) => ({
          recordId: r.recordId,
          appId: r.appId,
          key: r.key,
          value,
          recordType: r.recordType,
          hlc: r.hlc,
        })),
      );
    }
  }

  async getLabelsByRecordIds(
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, RecordLabel[]>> {
    const wanted = new Set<string>(recordIds);
    const result = new Map<StarkeepId, RecordLabel[]>();
    for (const label of this.labels.values()) {
      if (label.deletedAt || !wanted.has(label.recordId)) continue;
      let list = result.get(label.recordId);
      if (!list) result.set(label.recordId, (list = []));
      list.push(structuredClone(label));
    }
    return result;
  }

  /**
   * The reverse label read, run through the query grammar — see
   * `label-find.ts`.
   *
   * Built from the same plan the SQL adapters run and evaluated by the same
   * in-memory evaluator every other shared query uses here, so an in-memory run
   * and a real one page identically instead of agreeing only by coincidence.
   */
  async findByLabel(query: FindByLabelQuery): Promise<FindByLabelResult> {
    const plan = planFindByLabel(query);
    if (!plan) return emptyLabelPage();
    return labelPageFrom(
      await this.queryShared(LABEL_QUERY_TARGET, plan.query, {
        serverWhere: plan.serverWhere,
      }),
    );
  }

  // ---- Label sync ---------------------------------------------------------

  async putLabel(label: RecordLabel): Promise<void> {
    // Snapshot write, tombstone included — the apply path's equivalent of
    // put(record). Not upsertLabels, which would clear deletedAt and so
    // resurrect a retraction that arrived from a peer.
    this.labels.set(
      this.labelKey(label.recordId, label.appId, label.key, label.value),
      structuredClone(label),
    );
  }

  async getLabel(
    recordId: StarkeepId,
    appId: string,
    key: string,
    value: string,
  ): Promise<RecordLabel | null> {
    // Tombstones included: a tombstone is what a later arrival is compared to.
    const found = this.labels.get(this.labelKey(recordId, appId, key, value));
    return found ? structuredClone(found) : null;
  }

  async queryLabels(query: { limit?: number; cursor?: string }): Promise<{
    labels: RecordLabel[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const limit = query.limit ?? 500;
    // Primary-key order, and its own cursor — a different order from the
    // reverse index's, which is why the two token types are distinct.
    const ordered = [...this.labels.values()].sort(compareLabelScanOrder);
    const cursor = query.cursor ? decodeLabelScanCursor(query.cursor) : null;
    const after = cursor ? ordered.filter((l) => isAfterLabelScanCursor(l, cursor)) : ordered;
    const hasMore = after.length > limit;
    const page = after.slice(0, limit).map((l) => structuredClone(l));
    const last = page[page.length - 1];
    return {
      labels: page,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeLabelScanCursor({
              recordId: last.recordId,
              appId: last.appId,
              key: last.key,
              value: last.value,
            })
          : null,
    };
  }

  async getLabelNodeWatermarks(): Promise<Record<string, HLCTimestamp>> {
    const out: Record<string, HLCTimestamp> = {};
    for (const label of this.labels.values()) {
      const hlc = label.updatedAt;
      const existing = out[hlc.nodeId];
      if (
        !existing ||
        hlc.wallTime > existing.wallTime ||
        (hlc.wallTime === existing.wallTime && hlc.counter > existing.counter)
      ) {
        out[hlc.nodeId] = hlc;
      }
    }
    return out;
  }

  async tombstoneLabelsForRecord(recordId: StarkeepId, hlc: HLCTimestamp): Promise<void> {
    for (const label of this.labels.values()) {
      if (label.recordId !== recordId || label.deletedAt) continue;
      label.deletedAt = hlc;
      label.updatedAt = hlc;
      label.nodeId = hlc.nodeId;
    }
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.metadata.clear();
    this.labels.clear();
  }

  // ---- Object availability ------------------------------------------------

  private availability = new Map<string, StoredAvailability>();

  async getAvailability(objectStorageKeys: string[]): Promise<Map<string, StoredAvailability>> {
    const out = new Map<string, StoredAvailability>();
    for (const key of objectStorageKeys) {
      const row = this.availability.get(key);
      if (row) out.set(key, row);
    }
    return out;
  }

  async putAvailability(row: StoredAvailability): Promise<void> {
    this.availability.set(row.objectStorageKey, row);
  }

  async countRestoringObjects(): Promise<{ objectCount: number; bytes: number }> {
    let objectCount = 0;
    let bytes = 0;
    for (const row of this.availability.values()) {
      if (row.state !== "restoring") continue;
      objectCount += 1;
      for (const record of this.store.values()) {
        if (record.objectStorageKey === row.objectStorageKey) {
          bytes += record.sizeBytes;
          break;
        }
      }
    }
    return { objectCount, bytes };
  }
}

/** `hlc > peerWatermarks[hlc.nodeId]`, with an absent entry meaning "owed". */
function isOwed(hlc: HLCTimestamp, peerWatermarks: Record<string, HLCTimestamp>): boolean {
  const peer = peerWatermarks[hlc.nodeId];
  return !peer || compareHLC(hlc, peer) > 0;
}

/**
 * Group by author, sort ascending within each, and give every author its own
 * slice of `limit` — the same fair split `collectSince` performs on the SQL
 * path, and for the same reason: spending the budget in author order lets one
 * author that cannot drain starve every author after it, permanently.
 *
 * Authors that are cut short are reported in `truncated` with the last row
 * actually returned, which is what lets the caller cut a shipment that stays a
 * contiguous prefix across every stream. See `sync-engine/src/round-cut.ts`.
 *
 * The share is trimmed back to an HLC boundary first, for the reason
 * `trimToHlcBoundary` gives: a ceiling names a timestamp, so a slice landing
 * inside a run of rows sharing one HLC cannot be reported as a ceiling without
 * stranding the rest of that run forever. Where the SQL path has to widen its
 * read to get past a run longer than the share, this one already holds the
 * whole bucket and simply takes the run entire — the same outcome, reached
 * without the extra queries.
 */
function pageByNode<T>(
  items: T[],
  hlcOf: (item: T) => HLCTimestamp,
  limit: number,
): SincePage<T> {
  const byNode = new Map<string, T[]>();
  for (const item of items) {
    const nodeId = hlcOf(item).nodeId;
    const bucket = byNode.get(nodeId) ?? [];
    bucket.push(item);
    byNode.set(nodeId, bucket);
  }
  const nodeIds = Array.from(byNode.keys()).sort();
  const truncated: Record<string, HLCTimestamp | null> = {};
  if (nodeIds.length === 0) return { rows: [], hasMore: false, truncated };
  if (limit <= 0) {
    for (const nodeId of nodeIds) truncated[nodeId] = null;
    return { rows: [], hasMore: true, truncated };
  }

  const share = Math.max(1, Math.ceil(limit / nodeIds.length));
  const rows: T[] = [];
  let hasMore = false;
  for (const nodeId of nodeIds) {
    const bucket = byNode.get(nodeId)!.sort((a, b) => compareHLC(hlcOf(a), hlcOf(b)));
    let kept = bucket.slice(0, share);
    if (bucket.length > share) {
      kept = trimToHlcBoundary(kept, hlcOf(bucket[share]!), hlcOf);
      if (kept.length === 0) {
        // The whole share is one timestamp. Take the run to its end rather than
        // report a ceiling that would split it — the alternative is an author
        // that can never advance.
        let end = share;
        while (end < bucket.length && compareHLC(hlcOf(bucket[end]!), hlcOf(bucket[0]!)) === 0) {
          end += 1;
        }
        kept = bucket.slice(0, end);
      }
    }
    for (const item of kept) rows.push(structuredClone(item));
    if (kept.length < bucket.length) {
      truncated[nodeId] = hlcOf(kept[kept.length - 1]!);
      hasMore = true;
    }
  }
  return { rows, hasMore, truncated };
}

/**
 * A `DataRecord` as the columns of `shared.records`.
 *
 * One mapping, used by both the shared-plane query path and the record query's
 * grammar predicates: a `where` clause names a column, and the mock holds
 * camelCase objects.
 */
function recordToRow(record: DataRecord): Record<string, unknown> {
  return {
    id: record.id as string,
    type: record.type,
    created_at: serializeHLC(record.createdAt),
    updated_at: serializeHLC(record.updatedAt),
    node_id: record.updatedAt.nodeId,
    deleted_at: record.deletedAt ? serializeHLC(record.deletedAt) : null,
    version: record.version,
    content_hash: record.contentHash,
    object_storage_key: record.objectStorageKey,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    original_filename: record.originalFilename,
    origin_app_id: record.originAppId,
    parent_id: record.parentId,
  };
}
