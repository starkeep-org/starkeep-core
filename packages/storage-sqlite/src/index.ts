// `nodeSqliteDriver` is deliberately *not* re-exported here — it lives at
// `@starkeep/storage-sqlite/node`. Pulling it into this barrel would put a
// static `node:sqlite` import back in the graph and make the package
// unbundleable on React Native again. See `./node-driver.ts`.
export { SqliteDatabaseAdapter, type SqliteDriver } from "./adapter.js";
export { compiler as sqliteCompiler } from "./query-builder.js";
export type { SqliteDatabaseAdapterOptions } from "./adapter.js";
export { initializeLocalSchema } from "./schema/bootstrap.js";
export {
  appSyncableTableName,
  getAppSyncableNamespace,
  upsertAppSyncableNamespace,
  deleteAppSyncableNamespace,
  listAppSyncableNamespaces,
  SqliteAppSyncableNamespaceStore,
} from "./app-syncable/namespace.js";
export type { AppSyncableNamespace, AppSyncableTableInfo } from "./app-syncable/namespace.js";
export { SqliteAppSyncableApplier } from "./app-syncable/apply.js";
