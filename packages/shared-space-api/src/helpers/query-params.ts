export interface ParsedQueryParams {
  readonly types?: string[];
  readonly limit: number;
  readonly cursor?: string;
  readonly sortField?: string;
  readonly sortDirection?: "asc" | "desc";
}

export function parseQueryParams(
  query: Record<string, string> | undefined,
): ParsedQueryParams {
  if (!query) {
    return { limit: 50 };
  }

  const types = query.types ? query.types.split(",") : undefined;
  const limit = query.limit ? parseInt(query.limit, 10) : 50;
  const cursor = query.cursor || undefined;
  const sortField = query.sort || undefined;
  const sortDirection =
    query.order === "desc" ? ("desc" as const) : ("asc" as const);

  return {
    types,
    limit: Math.min(Math.max(limit, 1), 1000),
    cursor,
    sortField,
    sortDirection: sortField ? sortDirection : undefined,
  };
}
