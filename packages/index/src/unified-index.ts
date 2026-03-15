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

  return {
    async search(query: IndexQuery): Promise<IndexResult> {
      const { dataQuery } = await planQuery(query, databaseAdapter);
      const dataResult = await databaseAdapter.query(dataQuery);

      const dataRecords = dataResult.records.filter(
        (record): record is DataRecord => record.kind === "data",
      );

      if (dataRecords.length === 0) {
        return { items: [], nextCursor: null, hasMore: false };
      }

      const dataRecordIds = dataRecords.map((record) => record.id);
      const metadataResult = await databaseAdapter.query({
        kind: "metadata",
        filters: [{ field: "targetId", operator: "in", value: dataRecordIds }],
      });

      const metadataByTargetId = new Map<string, Record<string, MetadataRecord>>();
      for (const record of metadataResult.records) {
        if (record.kind !== "metadata") continue;
        const metadataRecord = record as MetadataRecord;
        const targetKey = metadataRecord.targetId as string;
        if (!metadataByTargetId.has(targetKey)) {
          metadataByTargetId.set(targetKey, {});
        }
        metadataByTargetId.get(targetKey)![metadataRecord.generatorId] = metadataRecord;
      }

      const items: IndexItem[] = dataRecords.map((dataRecord) => ({
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
      if (!record || record.kind !== "data") {
        return null;
      }

      const dataRecord = record as DataRecord;
      const metadataResult = await databaseAdapter.query({
        kind: "metadata",
        filters: [{ field: "targetId", operator: "eq", value: recordId }],
      });

      const metadata: Record<string, MetadataRecord> = {};
      for (const metadataEntry of metadataResult.records) {
        if (metadataEntry.kind === "metadata") {
          const metadataRecord = metadataEntry as MetadataRecord;
          metadata[metadataRecord.generatorId] = metadataRecord;
        }
      }

      return { dataRecord, metadata };
    },

    syncBoundary: boundary,
  };
}
