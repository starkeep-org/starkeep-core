import type { RawDatabase } from "@starkeep/storage-adapter";
import { sql, type CompiledQuery } from "kysely";
import type { AppManifest, FileAccess, LabelKey } from "@starkeep/admin-manifest";
import { appSyncableTableName, sqliteCompiler as k } from "@starkeep/storage-sqlite";

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

/**
 * Which label key each registered app uses to name its size-class rungs.
 *
 * Derived from the manifests the registry already stores whole, rather than
 * kept as a column beside the declared keys. The marker is a manifest field, so
 * a second copy of it is a second thing that can disagree with the first — and
 * the read that would have justified denormalizing it happens **once, at boot**,
 * where the cost of parsing a handful of manifests does not register.
 *
 * Every registered app counts, whatever its install status: the map exists to
 * read label rows that already exist, and a half-installed or half-removed
 * app's rows are exactly the ones that would otherwise be misread as originals.
 *
 * An app with no such key simply has no entry, which is the ordinary case —
 * most apps derive nothing.
 */
export function sizeClassKeysByApp(db: RawDatabase): Record<string, string> {
  const out: Record<string, string> = {};
  for (const app of listAppRegistry(db)) {
    const key = app.manifest.infraRequirements?.labelKeys?.find((entry) => entry.sizeClass)?.key;
    if (key !== undefined) out[app.appId] = key;
  }
  return out;
}

/**
 * Which registered apps declare their app-private blobs re-derivable.
 *
 * Read by the residency manager to answer one question — may this node drop the
 * last copy of one of this app's private files? Derived from the stored
 * manifests for the same reason {@link sizeClassKeysByApp} is: the declaration
 * lives in the manifest, and a denormalized second copy is a second thing that
 * can disagree with the first.
 *
 * Absence means non-regenerable, which is what every manifest written before
 * the field existed says and is the conservative direction. Calling precious
 * bytes re-derivable loses them; calling re-derivable bytes precious costs
 * disk.
 *
 * Every registered app counts, whatever its install status, for the same reason
 * `sizeClassKeysByApp` counts them: a half-removed app's blobs are exactly the
 * ones whose durability question is about to be asked.
 */
export function regenerableBlobApps(db: RawDatabase): Set<string> {
  const out = new Set<string>();
  for (const app of listAppRegistry(db)) {
    const files = app.manifest.infraRequirements?.appSpecificSyncable?.files;
    if (files?.enabled && files.regenerable) out.add(app.appId);
  }
  return out;
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

/**
 * Refresh an installed app's manifest and the columns derived from it.
 *
 * The row's identity survives: `hmac_secret` because re-minting it would strand
 * every signer holding the old one — the cloud verifier reads the local secret
 * through SSM, so a new secret 401s every signed request until the mirror step
 * runs — and `installed_at` because it records when the app arrived, not when
 * it was last reconciled. `status` is left to `setAppStatus`.
 */
export function updateAppRegistryManifest(
  db: RawDatabase,
  appId: string,
  manifest: AppManifest,
): void {
  run(
    db,
    k
      .updateTable("shared_app_registry")
      .set({
        name: manifest.name,
        version: manifest.version,
        tier: manifest.tier,
        manifest: JSON.stringify(manifest),
        updated_at: sql`datetime('now')`,
      })
      .where("app_id", "=", appId)
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

export { createAppSyncableTables, createReservedFileRecordsTable } from "@starkeep/storage-sqlite";

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
