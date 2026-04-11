import type { StarkeepId } from "@starkeep/core";
import { SyncStatus } from "@starkeep/core";
import type { DatabaseAdapter, Query, Filter } from "@starkeep/storage-adapter";
import type { IndexQuery } from "./types.js";

export interface PlannedQueries {
  readonly dataQuery: Query;
}

export async function planQuery(
  query: IndexQuery,
  databaseAdapter: DatabaseAdapter,
): Promise<PlannedQueries> {
  const filters: Filter[] = [];

  if (query.types && query.types.length > 0) {
    filters.push({ field: "type", operator: "in", value: query.types });
  }

  if (query.dateRange) {
    filters.push({
      field: "createdAt",
      operator: "gte",
      value: query.dateRange.start,
    });
    filters.push({
      field: "createdAt",
      operator: "lte",
      value: query.dateRange.end,
    });
  }

  if (query.syncBoundary === "sync-eligible") {
    filters.push({ field: "syncStatus", operator: "neq", value: SyncStatus.Local });
  } else if (query.syncBoundary === "local-only") {
    filters.push({ field: "syncStatus", operator: "eq", value: SyncStatus.Local });
  }

  if (query.fullTextSearch) {
    filters.push({ field: "type", operator: "like", value: query.fullTextSearch });
  }

  if (query.metadataFilters && query.metadataFilters.length > 0) {
    const targetIds = await resolveMetadataFilterTargetIds(query.metadataFilters, databaseAdapter);
    if (targetIds.length === 0) {
      return {
        dataQuery: {
          filters: [{ field: "id", operator: "in", value: [] }],
          limit: query.limit,
          cursor: query.cursor,
        },
      };
    }
    filters.push({ field: "id", operator: "in", value: targetIds });
  }

  const dataQuery: Query = {
    filters: filters.length > 0 ? filters : undefined,
    limit: query.limit,
    cursor: query.cursor,
  };

  return { dataQuery };
}

async function resolveMetadataFilterTargetIds(
  metadataFilters: readonly import("./types.js").MetadataFilter[],
  databaseAdapter: DatabaseAdapter,
): Promise<StarkeepId[]> {
  let intersectedTargetIds: Set<string> | null = null;

  for (const metadataFilter of metadataFilters) {
    const metadataQueryResult = await databaseAdapter.queryMetadata(
      metadataFilter.targetType,
      {
        generatorId: metadataFilter.generatorId,
        filters: [
          {
            field: metadataFilter.field,
            operator: metadataFilter.operator,
            value: metadataFilter.value,
          },
        ],
      },
    );

    const targetIdsForFilter = new Set(
      metadataQueryResult.entries.map((entry) => entry.targetId as string),
    );

    if (intersectedTargetIds === null) {
      intersectedTargetIds = targetIdsForFilter;
    } else {
      const filtered = new Set<string>();
      for (const identifier of intersectedTargetIds) {
        if (targetIdsForFilter.has(identifier)) {
          filtered.add(identifier);
        }
      }
      intersectedTargetIds = filtered;
    }
  }

  return [...(intersectedTargetIds ?? [])] as StarkeepId[];
}
