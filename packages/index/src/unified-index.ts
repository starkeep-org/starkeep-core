import type { StarkeepId } from "@starkeep/core";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { UnifiedIndex, IndexQuery, IndexItem, IndexResult } from "./types.js";
import { planQuery } from "./query-planner.js";

export interface CreateUnifiedIndexOptions {
  readonly databaseAdapter: DatabaseAdapter;
}

export function createUnifiedIndex(options: CreateUnifiedIndexOptions): UnifiedIndex {
  const { databaseAdapter } = options;

  return {
    async search(query: IndexQuery): Promise<IndexResult> {
      const { dataQuery } = await planQuery(query, databaseAdapter);
      const dataResult = await databaseAdapter.query(dataQuery);

      const items: IndexItem[] = dataResult.records.map((dataRecord) => ({ dataRecord }));

      return {
        items,
        nextCursor: dataResult.nextCursor,
        hasMore: dataResult.hasMore,
      };
    },

    async getWithMetadata(recordId: StarkeepId): Promise<IndexItem | null> {
      const record = await databaseAdapter.get(recordId);
      if (!record) return null;
      return { dataRecord: record };
    },
  };
}
