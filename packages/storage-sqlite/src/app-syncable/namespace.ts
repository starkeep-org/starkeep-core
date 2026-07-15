import type { DatabaseSync } from "node:sqlite";
import { compiler as qb } from "../query-builder.js";
import type {
  AppSyncableNamespace,
  AppSyncableTableInfo,
  AppSyncableNamespaceStore,
} from "@starkeep/shared-space-api";

export type { AppSyncableNamespace, AppSyncableTableInfo };

// `<appId>_syncable_<table>` is what the manifest convention pins, but appIds
// may contain dashes (e.g. "cloud-data-server") which aren't legal SQLite
// identifiers. Normalize the same way as cloud-side PG roles.
function normalizeAppId(appId: string): string {
  return appId.toLowerCase().replace(/-/g, "_");
}

export function appSyncableTableName(appId: string, tableName: string): string {
  return `${normalizeAppId(appId)}_syncable_${tableName}`;
}

function rowToNamespace(r: {
  app_id: string;
  tables_json: string;
  files_enabled: number;
}): AppSyncableNamespace {
  const tables: AppSyncableTableInfo[] = JSON.parse(r.tables_json);
  return {
    appId: r.app_id,
    tables,
    filesEnabled: r.files_enabled === 1,
    tableNames: tables.map((t) => t.name),
  };
}

export function upsertAppSyncableNamespace(
  db: DatabaseSync,
  appId: string,
  tables: AppSyncableTableInfo[],
  filesEnabled: boolean,
): void {
  const query = qb
    .insertInto("app_syncable_namespaces")
    .values({
      app_id: appId,
      tables_json: JSON.stringify(tables),
      files_enabled: filesEnabled ? 1 : 0,
    })
    .onConflict((oc) =>
      oc.column("app_id").doUpdateSet((eb) => ({
        tables_json: eb.ref("excluded.tables_json"),
        files_enabled: eb.ref("excluded.files_enabled"),
      })),
    )
    .compile();
  db.prepare(query.sql).run(...(query.parameters as (string | number)[]));
}

export function deleteAppSyncableNamespace(db: DatabaseSync, appId: string): void {
  const query = qb.deleteFrom("app_syncable_namespaces").where("app_id", "=", appId).compile();
  db.prepare(query.sql).run(...(query.parameters as string[]));
}

export function getAppSyncableNamespace(
  db: DatabaseSync,
  appId: string,
): AppSyncableNamespace | null {
  const query = qb
    .selectFrom("app_syncable_namespaces")
    .select(["app_id", "tables_json", "files_enabled"])
    .where("app_id", "=", appId)
    .compile();
  const row = db
    .prepare(query.sql)
    .get(...(query.parameters as string[])) as
    | { app_id: string; tables_json: string; files_enabled: number }
    | undefined;
  if (!row) return null;
  return rowToNamespace(row);
}

export function listAppSyncableNamespaces(db: DatabaseSync): AppSyncableNamespace[] {
  const query = qb
    .selectFrom("app_syncable_namespaces")
    .select(["app_id", "tables_json", "files_enabled"])
    .compile();
  const rows = db
    .prepare(query.sql)
    .all() as Array<{ app_id: string; tables_json: string; files_enabled: number }>;
  return rows.map(rowToNamespace);
}

/**
 * Object-oriented wrapper over the free functions above — implements the
 * `AppSyncableNamespaceStore` interface required by `createAppSpecificFactory`
 * and the sync applier.
 */
export class SqliteAppSyncableNamespaceStore implements AppSyncableNamespaceStore {
  constructor(private readonly db: DatabaseSync) {}

  get(appId: string): AppSyncableNamespace | null {
    return getAppSyncableNamespace(this.db, appId);
  }

  list(): AppSyncableNamespace[] {
    return listAppSyncableNamespaces(this.db);
  }
}
