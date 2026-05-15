import type { DatabaseSync } from "node:sqlite";
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
  db.prepare(
    `INSERT INTO app_syncable_namespaces (app_id, tables_json, files_enabled)
     VALUES (?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       tables_json = excluded.tables_json,
       files_enabled = excluded.files_enabled`,
  ).run(appId, JSON.stringify(tables), filesEnabled ? 1 : 0);
}

export function deleteAppSyncableNamespace(db: DatabaseSync, appId: string): void {
  db.prepare("DELETE FROM app_syncable_namespaces WHERE app_id = ?").run(appId);
}

export function getAppSyncableNamespace(
  db: DatabaseSync,
  appId: string,
): AppSyncableNamespace | null {
  const row = db
    .prepare(
      "SELECT app_id, tables_json, files_enabled FROM app_syncable_namespaces WHERE app_id = ?",
    )
    .get(appId) as { app_id: string; tables_json: string; files_enabled: number } | undefined;
  if (!row) return null;
  return rowToNamespace(row);
}

export function listAppSyncableNamespaces(db: DatabaseSync): AppSyncableNamespace[] {
  const rows = db
    .prepare(
      "SELECT app_id, tables_json, files_enabled FROM app_syncable_namespaces",
    )
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
