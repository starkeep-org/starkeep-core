import type { RawDatabase } from "@starkeep/storage-adapter";
import { sql, type CompiledQuery } from "kysely";
import type { AppManifest, FileAccess, LabelKey, SyncableTable } from "@starkeep/admin-manifest";
import { appSyncableTableName, sqliteCompiler as k } from "@starkeep/storage-sqlite";
import { FILE_RECORDS_TABLE, FILE_RECORDS_COLUMNS } from "@starkeep/shared-space-api";

export type Operation = "install" | "uninstall";
export type StepStatus = "pending" | "done" | "failed";

type SqlParam = null | number | bigint | string | Uint8Array;

function run(db: RawDatabase, compiled: CompiledQuery): void {
  db.prepare(compiled.sql).run(...(compiled.parameters as SqlParam[]));
}

function all<T>(db: RawDatabase, compiled: CompiledQuery): T[] {
  return db.prepare(compiled.sql).all(...(compiled.parameters as SqlParam[])) as T[];
}

export function recordStep(
  db: RawDatabase,
  appId: string,
  operation: Operation,
  step: string,
  status: StepStatus,
  error?: string,
): void {
  run(
    db,
    k
      .insertInto("shared_app_install_steps")
      .values({
        app_id: appId,
        operation,
        step,
        status,
        error: error ?? null,
        updated_at: sql`datetime('now')`,
      })
      .onConflict((oc) =>
        oc.columns(["app_id", "operation", "step"]).doUpdateSet((eb) => ({
          status: eb.ref("excluded.status"),
          error: eb.ref("excluded.error"),
          updated_at: sql`datetime('now')`,
        })),
      )
      .compile(),
  );
}

export function getCompletedSteps(
  db: RawDatabase,
  appId: string,
  operation: Operation,
): Set<string> {
  const rows = all<{ step: string }>(
    db,
    k
      .selectFrom("shared_app_install_steps")
      .select("step")
      .where("app_id", "=", appId)
      .where("operation", "=", operation)
      .where("status", "=", "done")
      .compile(),
  );
  return new Set(rows.map((r) => r.step));
}

export function clearStepLedger(db: RawDatabase, appId: string): void {
  run(db, k.deleteFrom("shared_app_install_steps").where("app_id", "=", appId).compile());
}

export interface InstallStepRow {
  operation: Operation;
  step: string;
  status: StepStatus;
  error: string | null;
  updatedAt: string;
}

export function listInstallSteps(db: RawDatabase, appId: string): InstallStepRow[] {
  const rows = all<{
    operation: string;
    step: string;
    status: string;
    error: string | null;
    updated_at: string;
  }>(
    db,
    k
      .selectFrom("shared_app_install_steps")
      .select(["operation", "step", "status", "error", "updated_at"])
      .where("app_id", "=", appId)
      .orderBy("updated_at", "asc")
      .orderBy("operation", "asc")
      .orderBy("step", "asc")
      .compile(),
  );
  return rows.map((r) => ({
    operation: r.operation as Operation,
    step: r.step,
    status: r.status as StepStatus,
    error: r.error,
    updatedAt: r.updated_at,
  }));
}

const APP_REGISTRY_COLUMNS = [
  "app_id",
  "name",
  "version",
  "tier",
  "manifest",
  "status",
  "hmac_secret",
  "installed_at",
  "updated_at",
] as const;

export function appRegistryRow(db: RawDatabase, appId: string): RegisteredApp | null {
  const [row] = all<RegisteredAppRow>(
    db,
    k
      .selectFrom("shared_app_registry")
      .select([...APP_REGISTRY_COLUMNS])
      .where("app_id", "=", appId)
      .compile(),
  );
  if (!row) return null;
  return toRegisteredApp(row);
}

export function listAppRegistry(db: RawDatabase): RegisteredApp[] {
  const rows = all<RegisteredAppRow>(
    db,
    k
      .selectFrom("shared_app_registry")
      .select([...APP_REGISTRY_COLUMNS])
      .orderBy("installed_at", "asc")
      .compile(),
  );
  return rows.map(toRegisteredApp);
}

function toRegisteredApp(row: RegisteredAppRow): RegisteredApp {
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

export function insertAppRegistry(
  db: RawDatabase,
  appId: string,
  manifest: AppManifest,
  hmacSecret: string,
): void {
  run(
    db,
    k
      .insertInto("shared_app_registry")
      .values({
        app_id: appId,
        name: manifest.name,
        version: manifest.version,
        tier: manifest.tier,
        manifest: JSON.stringify(manifest),
        status: "installing",
        hmac_secret: hmacSecret,
      })
      .compile(),
  );
}

export function setAppStatus(
  db: RawDatabase,
  appId: string,
  status: RegisteredApp["status"],
): void {
  run(
    db,
    k
      .updateTable("shared_app_registry")
      .set({ status, updated_at: sql`datetime('now')` })
      .where("app_id", "=", appId)
      .compile(),
  );
}

export function deleteAppRegistry(db: RawDatabase, appId: string): void {
  run(db, k.deleteFrom("shared_app_registry").where("app_id", "=", appId).compile());
}

/**
 * Writes one `shared_access_grants` row per declared Starkeep type (type_id =
 * `<category>/<format>`). Apps with `fileAccessAll` (only Starkeep Drive) write
 * no rows — the local data-server grants Drive all-access by app id (it cannot
 * enumerate `other/*` types). Mirrors the cloud `runAppInstallDdl` rule.
 */
export function insertAccessGrants(
  db: RawDatabase,
  appId: string,
  fileAccess: FileAccess[],
): void {
  for (const entry of fileAccess) {
    for (const type of entry.types) {
      run(
        db,
        k
          .insertInto("shared_access_grants")
          .values({
            app_id: appId,
            type_id: type,
            access: entry.access,
            metadata_write: entry.metadataWrite ? 1 : 0,
          })
          .onConflict((oc) =>
            oc.columns(["app_id", "type_id"]).doUpdateSet((eb) => ({
              access: eb.ref("excluded.access"),
              metadata_write: eb.ref("excluded.metadata_write"),
            })),
          )
          .compile(),
      );
    }
  }
}

export function deleteAccessGrants(db: RawDatabase, appId: string): void {
  run(db, k.deleteFrom("shared_access_grants").where("app_id", "=", appId).compile());
}

/**
 * Writes one `shared_app_label_keys` row per manifest-declared label key. The
 * label write path rejects any key not in this table, so this is where an app's
 * publishable schema is fixed.
 *
 * Deletes rows for keys the manifest no longer declares, so an upgrade that
 * drops a key stops new writes to it. The *label rows* themselves survive that
 * — see `deleteAppLabelKeys` for why an undeclared key with live rows is the
 * intended steady state rather than corruption.
 */
export function insertAppLabelKeys(
  db: RawDatabase,
  appId: string,
  labelKeys: LabelKey[],
): void {
  for (const entry of labelKeys) {
    run(
      db,
      k
        .insertInto("shared_app_label_keys")
        .values({ app_id: appId, key: entry.key, description: entry.description })
        .onConflict((oc) =>
          oc.columns(["app_id", "key"]).doUpdateSet((eb) => ({
            description: eb.ref("excluded.description"),
          })),
        )
        .compile(),
    );
  }

  // An upgrade that removes a key must revoke it, not just fail to re-add it.
  const declared = labelKeys.map((e) => e.key);
  let stale = k.deleteFrom("shared_app_label_keys").where("app_id", "=", appId);
  if (declared.length > 0) {
    stale = stale.where("key", "not in", declared);
  }
  run(db, stale.compile());
}

/**
 * Drops an app's declared keys on uninstall. **The label rows it wrote survive**,
 * matching the existing "shared data outlives uninstall" principle — a reader
 * shouldn't lose annotations because the producer was temporarily removed, and
 * reinstalling re-exposes them.
 *
 * So live label rows can reference an undeclared key, and that is the intended
 * steady state: reads and reverse queries return them normally, new writes to
 * the key are rejected, and **retraction stays legal** (it is scoped by primary
 * key, which contains `app_id`). Refusing retraction here would strand rows the
 * app can no longer clean up — which is what the obvious implementation, one
 * that validates the key on every write path including retraction, would do.
 */
export function deleteAppLabelKeys(db: RawDatabase, appId: string): void {
  run(db, k.deleteFrom("shared_app_label_keys").where("app_id", "=", appId).compile());
}

const SQLITE_COLUMN_TYPES: Record<SyncableTable["columns"][number]["type"], "text" | "integer" | "real" | "blob"> = {
  text: "text",
  integer: "integer",
  real: "real",
  blob: "blob",
  boolean: "integer",
};

interface SyncableColumnDef {
  name: string;
  type: "text" | "integer" | "real" | "blob";
  notNull: boolean;
  primaryKey: boolean;
}

/**
 * Emits the CREATE TABLE / CREATE INDEX statements shared by manifest-declared
 * syncable tables and the reserved file-records table. updated_at, node_id
 * (denormalized from updated_at by the applier) and deleted_at are reserved by
 * the sync runtime for inline-HLC change tracking; they are appended
 * automatically and must not be declared in the manifest. (node_id, updated_at)
 * backs the responder's per-node coverage watermark query.
 */
function createSyncableTable(
  db: RawDatabase,
  fullName: string,
  columns: SyncableColumnDef[],
): void {
  let tb = k.schema
    .createTable(fullName)
    .ifNotExists();
  for (const c of columns) {
    tb = tb.addColumn(c.name, c.type, (col) =>
      c.notNull || c.primaryKey ? col.notNull() : col,
    );
  }
  tb = tb
    .addColumn("updated_at", "text", (col) => col.notNull())
    .addColumn("node_id", "text", (col) => col.notNull())
    .addColumn("deleted_at", "text");
  // `syncableTableSchema` refuses a table with no primary key
  // (`admin-manifest/src/schema.ts`), so this branch is now unreachable through
  // any manifest-driven install. It stays because a table created without a
  // constraint is *silently* wrong rather than loudly wrong: the applier's
  // UPSERT would have nothing to conflict on, so every replay of a wire entry —
  // a repair round, a re-ship after a lost response, a watermark reset —
  // inserts the row again, and a tombstone could never name the row it retracts.
  const pks = columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (pks.length > 0) {
    tb = tb.addPrimaryKeyConstraint(`pk_${fullName}`, pks as never[]);
  }
  db.exec(tb.compile().sql);
  db.exec(
    k.schema
      .createIndex(`idx_${fullName}_updated_at`)
      .ifNotExists()
      .on(fullName)
      .column("updated_at")
      .compile().sql,
  );
  db.exec(
    k.schema
      .createIndex(`idx_${fullName}_node_watermark`)
      .ifNotExists()
      .on(fullName)
      .columns(["node_id", "updated_at"])
      .compile().sql,
  );
}

export function createAppSyncableTables(
  db: RawDatabase,
  appId: string,
  tables: SyncableTable[],
): void {
  for (const table of tables) {
    createSyncableTable(
      db,
      appSyncableTableName(appId, table.name),
      table.columns.map((c) => ({
        name: c.name,
        type: SQLITE_COLUMN_TYPES[c.type],
        notNull: Boolean(c.notNull),
        primaryKey: Boolean(c.primaryKey),
      })),
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
  db: RawDatabase,
  appId: string,
): void {
  createSyncableTable(
    db,
    appSyncableTableName(appId, FILE_RECORDS_TABLE),
    FILE_RECORDS_COLUMNS.map((c) => ({
      name: c.name,
      type: c.type === "integer" ? "integer" : "text",
      notNull: Boolean(c.notNull),
      primaryKey: Boolean(c.primaryKey),
    })),
  );
}

export function dropAppSyncableTables(
  db: RawDatabase,
  appId: string,
  tableNames: string[],
): void {
  for (const name of tableNames) {
    const fullName = appSyncableTableName(appId, name);
    db.exec(k.schema.dropTable(fullName).ifExists().compile().sql);
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
