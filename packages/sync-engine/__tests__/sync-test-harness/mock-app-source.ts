import {
  mergeDigestBuckets,
  DEFAULT_BUCKET_PREFIX_LENGTH,
  type DigestBucket,
} from "@starkeep/storage-adapter";
import { compareHLC, serializeHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";
import type {
  AppSyncableApplier,
  AppSyncableNamespace,
  AppSyncableNamespaceStore,
  AppSyncableRowEntry,
  ScanCapableApplier,
} from "../../src/types.js";

// Mirror of `FILE_RECORDS_TABLE` from `@starkeep/shared-space-api` and
// `sync-engine.ts` — kept in sync by hand because importing across the cycle
// isn't possible.
export const FILE_RECORDS_TABLE = "_starkeep_sync_records";

export interface MockAppRowStore {
  readonly applier: AppSyncableApplier & ScanCapableApplier;
  readonly namespaces: AppSyncableNamespaceStore;
  /** Direct row access for assertions; keyed by `${appId}::${table}::${pk}`. */
  readonly rows: Map<string, AppSyncableRowEntry>;
}

export interface TableSpec {
  readonly name: string;
  readonly pkColumns: readonly string[];
}

/**
 * In-memory `AppSyncableApplier` + namespace store for tests. LWW-on-timestamp
 * apply, scan returns all rows newer than a given HLC string. Matches the
 * semantics of the storage-sqlite/storage-aurora-dsql appliers closely enough
 * for sync-engine tests; details of SQL UPSERT generation are out of scope.
 */
export function makeMockAppSource(
  appId: string,
  tables: readonly TableSpec[],
): MockAppRowStore {
  const rows = new Map<string, AppSyncableRowEntry>();
  const ns: AppSyncableNamespace = {
    appId,
    tables: tables.map((t) => ({ name: t.name, pkColumns: [...t.pkColumns] })),
    filesEnabled: tables.some((t) => t.name === FILE_RECORDS_TABLE),
    tableNames: tables.map((t) => t.name),
  };
  const namespaces: AppSyncableNamespaceStore = {
    get: (id) => (id === appId ? ns : null),
    list: () => [ns],
  };

  function pkOf(entry: AppSyncableRowEntry): string {
    const tableInfo = tables.find((t) => t.name === entry.table);
    if (!tableInfo || tableInfo.pkColumns.length === 0) {
      return JSON.stringify(entry.row ?? entry.where ?? {});
    }
    const src = entry.row ?? entry.where ?? {};
    return tableInfo.pkColumns.map((c) => String(src[c])).join("/");
  }

  const applier: AppSyncableApplier & ScanCapableApplier = {
    async apply(entry) {
      const key = `${entry.appId}::${entry.table}::${pkOf(entry)}`;
      const existing = rows.get(key);
      if (existing && compareHLC(existing.timestamp, entry.timestamp) >= 0) {
        return;
      }
      rows.set(key, entry);
    },
    // Delta scan: rows the peer hasn't seen, one fair slice per author, with
    // per-author truncation marks — the same shape `collectSince` produces on
    // the SQL path, because `round-cut.ts` consumes both.
    async scanSince(scanAppId, table, peerWatermarks, limit) {
      const byNode = new Map<string, AppSyncableRowEntry[]>();
      for (const e of rows.values()) {
        if (e.appId !== scanAppId || e.table !== table) continue;
        const peer = peerWatermarks[e.timestamp.nodeId];
        if (peer && compareHLC(e.timestamp, peer) <= 0) continue;
        const bucket = byNode.get(e.timestamp.nodeId) ?? [];
        bucket.push(e);
        byNode.set(e.timestamp.nodeId, bucket);
      }
      const nodeIds = Array.from(byNode.keys()).sort();
      const truncated: Record<string, HLCTimestamp | null> = {};
      if (nodeIds.length === 0) return { rows: [], hasMore: false, truncated };
      if (limit <= 0) {
        for (const nodeId of nodeIds) truncated[nodeId] = null;
        return { rows: [], hasMore: true, truncated };
      }
      const share = Math.max(1, Math.ceil(limit / nodeIds.length));
      const out: AppSyncableRowEntry[] = [];
      let hasMore = false;
      for (const nodeId of nodeIds) {
        const bucket = byNode
          .get(nodeId)!
          .sort((a, b) => compareHLC(a.timestamp, b.timestamp));
        const kept = bucket.slice(0, share);
        out.push(...kept);
        if (bucket.length > share) {
          truncated[nodeId] = kept[kept.length - 1]!.timestamp;
          hasMore = true;
        }
      }
      return { rows: out, hasMore, truncated };
    },
    async bucketDigest(scanAppId, table, prefixLength = DEFAULT_BUCKET_PREFIX_LENGTH) {
      const buckets: DigestBucket[] = [];
      for (const e of rows.values()) {
        if (e.appId !== scanAppId || e.table !== table) continue;
        buckets.push({
          nodeId: e.timestamp.nodeId,
          bucket: serializeHLC(e.timestamp).slice(0, prefixLength),
          count: 1,
        });
      }
      return mergeDigestBuckets(buckets);
    },
    async getNodeWatermarks(scanAppId, table) {
      const out: Record<string, HLCTimestamp> = {};
      for (const e of rows.values()) {
        if (e.appId !== scanAppId || e.table !== table) continue;
        const existing = out[e.timestamp.nodeId];
        if (!existing || compareHLC(e.timestamp, existing) > 0) {
          out[e.timestamp.nodeId] = e.timestamp;
        }
      }
      return out;
    },
  };

  return { applier, namespaces, rows };
}
