import type { DatabaseSync } from "node:sqlite";
import type { AppManifest, FileAccess, SyncableTable } from "@starkeep/admin-manifest";
import { appSyncableTableName } from "@starkeep/storage-sqlite";
import { FILE_RECORDS_TABLE, FILE_RECORDS_COLUMNS } from "@starkeep/shared-space-api";

export type Operation = "install" | "uninstall";
export type StepStatus = "pending" | "done" | "failed";

export function recordStep(
  db: DatabaseSync,
  appId: string,
  operation: Operation,
  step: string,
  status: StepStatus,
  error?: string,
): void {
  db.prepare(
    `INSERT INTO shared_app_install_steps (app_id, operation, step, status, error, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(app_id, operation, step)
     DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = datetime('now')`,
  ).run(appId, operation, step, status, error ?? null);
}

export function getCompletedSteps(
  db: DatabaseSync,
  appId: string,
  operation: Operation,
): Set<string> {
  const rows = db
    .prepare(
      "SELECT step FROM shared_app_install_steps WHERE app_id = ? AND operation = ? AND status = 'done'",
    )
    .all(appId, operation) as Array<{ step: string }>;
  return new Set(rows.map((r) => r.step));
}

export function clearStepLedger(db: DatabaseSync, appId: string): void {
  db.prepare("DELETE FROM shared_app_install_steps WHERE app_id = ?").run(appId);
}

export function appRegistryRow(db: DatabaseSync, appId: string): RegisteredApp | null {
  const row = db
    .prepare(
      `SELECT app_id, name, version, tier, manifest, status, hmac_secret, installed_at, updated_at
       FROM shared_app_registry WHERE app_id = ?`,
    )
    .get(appId) as RegisteredAppRow | undefined;
  if (!row) return null;
  return {
    appId: row.app_id,
    name: row.name,
    version: row.version,
    tier: row.tier,
    manifest: JSON.parse(row.manifest) as AppManifest,
    status: row.status as RegisteredApp["status"],
    hmacSecret: row.hmac_secret,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

export function listAppRegistry(db: DatabaseSync): RegisteredApp[] {
  const rows = db
    .prepare(
      `SELECT app_id, name, version, tier, manifest, status, hmac_secret, installed_at, updated_at
       FROM shared_app_registry ORDER BY installed_at ASC`,
    )
    .all() as RegisteredAppRow[];
  return rows.map((row) => ({
    appId: row.app_id,
    name: row.name,
    version: row.version,
    tier: row.tier,
    manifest: JSON.parse(row.manifest) as AppManifest,
    status: row.status as RegisteredApp["status"],
    hmacSecret: row.hmac_secret,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  }));
}

export function insertAppRegistry(
  db: DatabaseSync,
  appId: string,
  manifest: AppManifest,
  hmacSecret: string,
): void {
  db.prepare(
    `INSERT INTO shared_app_registry (app_id, name, version, tier, manifest, status, hmac_secret)
     VALUES (?, ?, ?, ?, ?, 'installing', ?)`,
  ).run(appId, manifest.name, manifest.version, manifest.tier, JSON.stringify(manifest), hmacSecret);
}

export function setAppStatus(
  db: DatabaseSync,
  appId: string,
  status: RegisteredApp["status"],
): void {
  db.prepare(
    "UPDATE shared_app_registry SET status = ?, updated_at = datetime('now') WHERE app_id = ?",
  ).run(status, appId);
}

export function deleteAppRegistry(db: DatabaseSync, appId: string): void {
  db.prepare("DELETE FROM shared_app_registry WHERE app_id = ?").run(appId);
}

/**
 * Writes one `shared_access_grants` row per declared extension (type_id =
 * extension). Apps with `fileAccessAll` (only Starkeep Drive) write no rows —
 * the local data-server grants Drive all-access by app id (it cannot enumerate
 * unmapped/`other` extensions). Mirrors the cloud `runAppInstallDdl` rule.
 */
export function insertAccessGrants(
  db: DatabaseSync,
  appId: string,
  fileAccess: FileAccess[],
): void {
  const stmt = db.prepare(
    `INSERT INTO shared_access_grants (app_id, type_id, access, metadata_write)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, type_id) DO UPDATE SET
       access = excluded.access,
       metadata_write = excluded.metadata_write`,
  );
  for (const entry of fileAccess) {
    for (const ext of entry.extensions) {
      stmt.run(appId, ext, entry.access, entry.metadataWrite ? 1 : 0);
    }
  }
}

export function deleteAccessGrants(db: DatabaseSync, appId: string): void {
  db.prepare("DELETE FROM shared_access_grants WHERE app_id = ?").run(appId);
}

const SQLITE_COLUMN_TYPES: Record<SyncableTable["columns"][number]["type"], string> = {
  text: "TEXT",
  integer: "INTEGER",
  real: "REAL",
  blob: "BLOB",
  boolean: "INTEGER",
};

export function createAppSyncableTables(
  db: DatabaseSync,
  appId: string,
  tables: SyncableTable[],
): void {
  for (const table of tables) {
    const fullName = appSyncableTableName(appId, table.name);
    const columnDdl = table.columns
      .map((c) => {
        const parts = [`"${c.name}"`, SQLITE_COLUMN_TYPES[c.type]];
        if (c.notNull || c.primaryKey) parts.push("NOT NULL");
        return parts.join(" ");
      })
      .join(", ");
    const pks = table.columns.filter((c) => c.primaryKey).map((c) => `"${c.name}"`);
    const pkClause = pks.length > 0 ? `, PRIMARY KEY (${pks.join(", ")})` : "";
    // updated_at and deleted_at are reserved by the sync runtime for inline-HLC
    // change tracking; they are appended automatically and must not be declared
    // in the manifest.
    db.exec(
      `CREATE TABLE IF NOT EXISTS "${fullName}" (${columnDdl}, "updated_at" TEXT NOT NULL, "deleted_at" TEXT${pkClause})`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS "idx_${fullName}_updated_at" ON "${fullName}"("updated_at")`,
    );
  }
}

/**
 * Create the framework-owned `_starkeep_sync_records` table for an app that
 * opted into `filesEnabled`. Same column shape as the manifest-declared
 * syncable tables (plus the standard updated_at/deleted_at HLC columns) so
 * the LWW applier can treat it uniformly.
 */
export function createReservedFileRecordsTable(
  db: DatabaseSync,
  appId: string,
): void {
  const fullName = appSyncableTableName(appId, FILE_RECORDS_TABLE);
  const columnDdl = FILE_RECORDS_COLUMNS.map((c) => {
    const sqlType = c.type === "integer" ? "INTEGER" : "TEXT";
    const parts = [`"${c.name}"`, sqlType];
    if (c.notNull || c.primaryKey) parts.push("NOT NULL");
    return parts.join(" ");
  }).join(", ");
  const pks = FILE_RECORDS_COLUMNS.filter((c) => c.primaryKey).map(
    (c) => `"${c.name}"`,
  );
  const pkClause = pks.length > 0 ? `, PRIMARY KEY (${pks.join(", ")})` : "";
  db.exec(
    `CREATE TABLE IF NOT EXISTS "${fullName}" (${columnDdl}, "updated_at" TEXT NOT NULL, "deleted_at" TEXT${pkClause})`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS "idx_${fullName}_updated_at" ON "${fullName}"("updated_at")`,
  );
}

export function dropAppSyncableTables(
  db: DatabaseSync,
  appId: string,
  tableNames: string[],
): void {
  for (const name of tableNames) {
    const fullName = appSyncableTableName(appId, name);
    db.exec(`DROP TABLE IF EXISTS "${fullName}"`);
  }
}

export interface RegisteredApp {
  appId: string;
  name: string;
  version: string;
  tier: string;
  manifest: AppManifest;
  status: "installing" | "active" | "uninstalling";
  hmacSecret: string;
  installedAt: string;
  updatedAt: string;
}

interface RegisteredAppRow {
  app_id: string;
  name: string;
  version: string;
  tier: string;
  manifest: string;
  status: string;
  hmac_secret: string;
  installed_at: string;
  updated_at: string;
}
