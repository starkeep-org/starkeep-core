import type { StarkeepId, HLCTimestamp } from "@starkeep/core";
import { SyncStatus, NotFoundError } from "@starkeep/core";
import type { DatabaseAdapter, Filter } from "@starkeep/storage-adapter";
import type { SyncBoundary } from "./types.js";

export function createSyncBoundary(databaseAdapter: DatabaseAdapter): SyncBoundary {
  return {
    async markSyncEligible(recordId: StarkeepId): Promise<void> {
      const record = await databaseAdapter.get(recordId);
      if (!record) {
        throw new NotFoundError("Record", recordId);
      }
      record.syncStatus = SyncStatus.PendingPush;
      await databaseAdapter.put(record);
    },

    async markLocalOnly(recordId: StarkeepId): Promise<void> {
      const record = await databaseAdapter.get(recordId);
      if (!record) {
        throw new NotFoundError("Record", recordId);
      }
      record.syncStatus = SyncStatus.Local;
      await databaseAdapter.put(record);
    },

    async isSyncEligible(recordId: StarkeepId): Promise<boolean> {
      const record = await databaseAdapter.get(recordId);
      if (!record) {
        return false;
      }
      return record.syncStatus !== SyncStatus.Local;
    },

    async getSyncEligibleIds(since?: HLCTimestamp): Promise<StarkeepId[]> {
      const filters: Filter[] = [
        { field: "syncStatus", operator: "neq", value: SyncStatus.Local },
      ];

      if (since) {
        filters.push({
          field: "updatedAt",
          operator: "gte",
          value: since,
        });
      }

      const result = await databaseAdapter.query({
        kind: "data",
        filters,
      });

      return result.records.map((record) => record.id);
    },
  };
}
