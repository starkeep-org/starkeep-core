import type {
  DataRecord,
  HLCTimestamp,
  MetadataRow,
  RecordLabel,
  StarkeepId,
} from "@starkeep/protocol-primitives";
import { compareHLC, serializeHLC } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "../database/adapter.js";
import {
  mergeDigestBuckets,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DigestBucket,
} from "../database/digest-queries.js";
import type { SincePage } from "../database/since-queries.js";
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
} from "../database/types.js";
import {
  encodeLabelCursor,
  decodeLabelCursor,
  encodeLabelScanCursor,
  decodeLabelScanCursor,
  compareLabelOrder,
  compareLabelScanOrder,
  isAfterLabelCursor,
  isAfterLabelScanCursor,
} from "../database/label-cursor.js";

export class MockDatabaseAdapter implements DatabaseAdapter {
  private store = new Map<string, DataRecord>();
  private metadata = new Map<string, Map<string, MetadataRow>>();
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
    if (query.sort) {
      records.sort((a, b) => {
        for (const sortField of query.sort!) {
          const aValue = (a as unknown as Record<string, unknown>)[sortField.field] as string | number;
          const bValue = (b as unknown as Record<string, unknown>)[sortField.field] as string | number;
          if (aValue < bValue) return sortField.direction === "asc" ? -1 : 1;
          if (aValue > bValue) return sortField.direction === "asc" ? 1 : -1;
        }
        return 0;
      });
    }

    const limit = query.limit ?? records.length;
    const cursorIndex = query.cursor
      ? records.findIndex((record) => record.id === query.cursor) + 1
      : 0;

    const sliced = records.slice(cursorIndex, cursorIndex + limit);
    const hasMore = cursorIndex + limit < records.length;

    return {
      records: sliced.map((record) => structuredClone(record)),
      nextCursor: hasMore ? sliced[sliced.length - 1].id : null,
      hasMore,
    };
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

  async putMetadata(typeId: string, row: MetadataRow): Promise<void> {
    let typeTable = this.metadata.get(typeId);
    if (!typeTable) {
      typeTable = new Map();
      this.metadata.set(typeId, typeTable);
    }
    typeTable.set(row.recordId, structuredClone(row));
  }

  async getMetadata(typeId: string, recordId: StarkeepId): Promise<MetadataRow | null> {
    const row = this.metadata.get(typeId)?.get(recordId);
    return row ? structuredClone(row) : null;
  }

  async getMetadataByIds(
    typeId: string,
    recordIds: StarkeepId[],
  ): Promise<Map<StarkeepId, MetadataRow>> {
    const table = this.metadata.get(typeId);
    const result = new Map<StarkeepId, MetadataRow>();
    if (!table) return result;
    for (const id of recordIds) {
      const row = table.get(id);
      if (row) result.set(id, structuredClone(row));
    }
    return result;
  }

  async deleteMetadata(typeId: string, recordId: StarkeepId): Promise<void> {
    this.metadata.get(typeId)?.delete(recordId);
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

  async findByLabel(query: FindByLabelQuery): Promise<FindByLabelResult> {
    const limit = query.limit ?? 50;
    const matches = [...this.labels.values()].filter(
      (l) =>
        !l.deletedAt &&
        l.appId === query.appId &&
        l.key === query.key &&
        (query.value === undefined || l.value === query.value) &&
        (query.readableTypes === undefined || query.readableTypes.has(l.recordType)),
    );

    // Nulls first, then by value, then by id. Both the order and the "strictly
    // after the cursor" test come from label-cursor.ts, which is also where the
    // SQL adapters' predicate is spelled — so an in-memory run and a real one
    // page identically instead of agreeing only by coincidence.
    matches.sort(compareLabelOrder);

    const cursor = query.cursor ? decodeLabelCursor(query.cursor) : null;
    const after = cursor ? matches.filter((l) => isAfterLabelCursor(l, cursor)) : matches;

    const hasMore = after.length > limit;
    const page = after.slice(0, limit).map((l) => structuredClone(l));
    const last = page[page.length - 1];
    return {
      labels: page,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeLabelCursor({ value: last.value, recordId: last.recordId })
          : null,
    };
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
    const kept = bucket.slice(0, share);
    for (const item of kept) rows.push(structuredClone(item));
    if (bucket.length > share) {
      truncated[nodeId] = hlcOf(kept[kept.length - 1]!);
      hasMore = true;
    }
  }
  return { rows, hasMore, truncated };
}
