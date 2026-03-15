export type {
  MetadataFilter,
  SyncBoundaryFilter,
  IndexQuery,
  IndexItem,
  IndexResult,
  SyncBoundary,
  UnifiedIndex,
} from "./types.js";

export { createUnifiedIndex, type CreateUnifiedIndexOptions } from "./unified-index.js";
export { createSyncBoundary } from "./sync-boundary.js";
export { planQuery, type PlannedQueries } from "./query-planner.js";
