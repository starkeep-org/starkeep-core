import type { DatabaseAdapter, Query, Filter } from "@starkeep/storage-adapter";
import type { IndexQuery } from "./types.js";

export interface PlannedQueries {
  readonly dataQuery: Query;
}

export async function planQuery(
  query: IndexQuery,
  _databaseAdapter: DatabaseAdapter,
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

  if (query.fullTextSearch) {
    filters.push({ field: "type", operator: "like", value: query.fullTextSearch });
  }

  const dataQuery: Query = {
    filters: filters.length > 0 ? filters : undefined,
    limit: query.limit,
    cursor: query.cursor,
  };

  return { dataQuery };
}
