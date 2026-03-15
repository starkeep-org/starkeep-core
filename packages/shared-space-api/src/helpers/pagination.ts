import type { QueryResult } from "@starkeep/storage-adapter";

export interface PaginatedApiResponse {
  readonly data: unknown[];
  readonly pagination: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly count: number;
  };
}

export function formatPaginatedResponse(
  result: QueryResult,
): PaginatedApiResponse {
  return {
    data: result.records,
    pagination: {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      count: result.records.length,
    },
  };
}
