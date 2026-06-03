export type {
  IndexQuery,
  IndexItem,
  IndexResult,
  UnifiedIndex,
} from "./types.js";

export { createUnifiedIndex, type CreateUnifiedIndexOptions } from "./unified-index.js";
export { planQuery, type PlannedQueries } from "./query-planner.js";
