import type { DatabaseSync } from "node:sqlite";

export interface AppSyncableNamespaceRow {
  appId: string;
  tableNames: string[];
  filesEnabled: boolean;
}

// `<appId>_syncable_<table>` is what the manifest convention pins, but appIds
// may contain dashes (e.g. "cloud-data-server") which aren't legal SQLite
// identifiers. Normalize the same way as cloud-side PG roles.
function normalizeAppId(appId: string): string {
  return appId.toLowerCase().replace(/-/g, "_");
}

export function appSyncableTableName(appId: string, tableName: string): string {
  return `${normalizeAppId(appId)}_syncable_${tableName}`;
}

export function upsertAppSyncableNamespace(
  db: DatabaseSync,
  appId: string,
  tableNames: string[],
  filesEnabled: boolean,
): void {
  db.prepare(
    `INSERT INTO app_syncable_namespaces (app_id, table_names_json, files_enabled)
     VALUES (?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       table_names_json = excluded.table_names_json,
       files_enabled = excluded.files_enabled`,
  ).run(appId, JSON.stringify(tableNames), filesEnabled ? 1 : 0);
}

export function deleteAppSyncableNamespace(db: DatabaseSync, appId: string): void {
  db.prepare("DELETE FROM app_syncable_namespaces WHERE app_id = ?").run(appId);
}

export function getAppSyncableNamespace(
  db: DatabaseSync,
  appId: string,
): AppSyncableNamespaceRow | null {
  const row = db
    .prepare(
      "SELECT app_id, table_names_json, files_enabled FROM app_syncable_namespaces WHERE app_id = ?",
    )
    .get(appId) as { app_id: string; table_names_json: string; files_enabled: number } | undefined;
  if (!row) return null;
  return {
    appId: row.app_id,
    tableNames: JSON.parse(row.table_names_json) as string[],
    filesEnabled: row.files_enabled === 1,
  };
}

export function listAppSyncableNamespaces(db: DatabaseSync): AppSyncableNamespaceRow[] {
  const rows = db
    .prepare(
      "SELECT app_id, table_names_json, files_enabled FROM app_syncable_namespaces",
    )
    .all() as Array<{ app_id: string; table_names_json: string; files_enabled: number }>;
  return rows.map((r) => ({
    appId: r.app_id,
    tableNames: JSON.parse(r.table_names_json) as string[],
    filesEnabled: r.files_enabled === 1,
  }));
}
