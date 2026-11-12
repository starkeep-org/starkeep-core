/**
 * `@starkeep/app-client/snapshot`: arbitrary read-only SQL over a cached copy of
 * the app's own tables.
 *
 * A separate subpath because it imports `node:sqlite`, which the main entry,
 * the edge entry and every browser bundle must not.
 *
 * `createSnapshotSql` is what an app's server uses. `createSnapshotCache` is the
 * cache underneath, for a server that loads rows some other way.
 */
export {
  createSnapshotSql,
  type SnapshotSql,
  type SnapshotSqlOptions,
  type SnapshotSqlQuery,
  type SnapshotSqlResult,
} from "./snapshot/request.js";
export {
  createSnapshotCache,
  type SnapshotCache,
  type SnapshotCacheOptions,
  type SnapshotCacheQuery,
  type SnapshotColumnType,
  type SnapshotLoadContext,
  type SnapshotResult,
  type SnapshotRow,
  type SnapshotTable,
} from "./snapshot/cache.js";
export {
  SnapshotAccessError,
  SnapshotLoadError,
  SnapshotReadOnlyError,
  SnapshotTooLargeError,
} from "./snapshot/errors.js";
