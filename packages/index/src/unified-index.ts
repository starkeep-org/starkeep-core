import type { StarkeepId, DataRecord, MetadataRecord } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { UnifiedIndex, IndexQuery, IndexItem, IndexResult } from "./types.js";
import { planQuery } from "./query-planner.js";
import { createSyncBoundary } from "./sync-boundary.js";

export interface CreateUnifiedIndexOptions {
  readonly databaseAdapter: DatabaseAdapter;
}

export function createUnifiedIndex(options: CreateUnifiedIndexOptions): UnifiedIndex {
  const { databaseAdapter } = options;
  const boundary = createSyncBoundary(databaseAdapter);

  async function fetchMetadataForRecords(
    dataRecords: DataRecord[],
  ): Promise<Map<string, Record<string, MetadataRecord>>> {
    const metadataByTargetId = new Map<string, Record<string, MetadataRecord>>();

    // Group records by type so we can use per-type queryMetadata.
    const recordsByType = new Map<string, DataRecord[]>();
    for (const record of dataRecords) {
      const existing = recordsByType.get(record.type) ?? [];
      existing.push(record);
      recordsByType.set(record.type, existing);
    }

    for (const [type, records] of recordsByType) {
      const targetIds = records.map((r) => r.id);
      const result = await databaseAdapter.queryMetadata(type, { targetIds });

      for (const entry of result.entries) {
        const key = entry.targetId as string;
        if (!metadataByTargetId.has(key)) {
          metadataByTargetId.set(key, {});
        }
        metadataByTargetId.get(key)![entry.generatorId] = entry;
      }
    }

    return metadataByTargetId;
  }

  return {
    async search(query: IndexQuery): Promise<IndexResult> {
      const { dataQuery } = await planQuery(query, databaseAdapter);
      const dataResult = await databaseAdapter.query(dataQuery);

      if (dataResult.records.length === 0) {
        return { items: [], nextCursor: null, hasMore: false };
      }

      const metadataByTargetId = await fetchMetadataForRecords(dataResult.records);

      const items: IndexItem[] = dataResult.records.map((dataRecord) => ({
        dataRecord,
        metadata: metadataByTargetId.get(dataRecord.id as string) ?? {},
      }));

      return {
        items,
        nextCursor: dataResult.nextCursor,
        hasMore: dataResult.hasMore,
      };
    },

    async getWithMetadata(recordId: StarkeepId): Promise<IndexItem | null> {
      const record = await databaseAdapter.get(recordId);
      if (!record) return null;

      const metadataByTargetId = await fetchMetadataForRecords([record]);
      const metadata = metadataByTargetId.get(recordId as string) ?? {};

      return { dataRecord: record, metadata };
    },

    syncBoundary: boundary,
  };
}
