import type { RawDatabase } from "@starkeep/storage-adapter";
import { randomBytes } from "node:crypto";
import { validateManifest, type AppManifest } from "@starkeep/admin-manifest";
import { PROTOCOL_VERSION } from "@starkeep/protocol-primitives";
import { protocolRefusal, rawAppId } from "../protocol-check.js";
import {
  appRegistryRow,
  clearStepLedger,
  deleteAccessGrants,
  deleteAppLabelKeys,
  deleteAppRegistry,
  deleteRetainedAppData,
  dropAppSyncableTables,
  getCompletedSteps,
  getRetainedAppData,
  inTransaction,
  insertAccessGrants,
  insertAppLabelKeys,
  insertAppRegistry,
  updateAppRegistryManifest,
  recordStep,
  setAppStatus,
  upsertRetainedAppData,
  type Operation,
} from "./registry.js";
import {
  appSyncableNamespaceTables,
  createAppSyncableTables,
  createReservedFileRecordsTable,
  deleteAppSyncableNamespace,
  getAppSyncableNamespace,
  upsertAppSyncableNamespace,
} from "@starkeep/storage-sqlite";

export interface InstallLocalResult {
  appId: string;
  hmacSecret: string;
}

export class LocalInstallError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LocalInstallError";
  }
}

export class ManifestValidationError extends LocalInstallError {
  constructor(readonly errors: string[]) {
    super(`Manifest validation failed: ${errors.join("; ")}`);
    this.name = "ManifestValidationError";
  }
}

/** The app needs a newer platform protocol than this data server speaks. */
export class ProtocolVersionError extends LocalInstallError {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolVersionError";
  }
}

/**
 * Install an app locally: registers it in shared_app_registry, mints an HMAC
 * secret, and writes per-type rows into shared_access_grants. Idempotent and
 * resumable via the shared_app_install_steps ledger.
 *
 * Returns the new (or existing) HMAC secret so the caller can hand it to the
 * app process for request signing.
 */
export interface InstallLocalOptions {
  /**
   * The folder the manifest came from. Start, Update from folder and cloud
   * deploys use it, so the app keeps running the copy the user approved.
   * Omitted for a built-in app; omitted on a reinstall, the pin stays.
   */
  sourceDir?: string;
}

export function installLocal(
  db: RawDatabase,
  rawManifest: unknown,
  options: InstallLocalOptions = {},
): InstallLocalResult {
  const refusal = protocolRefusal({
    appId: rawAppId(rawManifest),
    rawManifest,
    platformVersion: PROTOCOL_VERSION,
    target: "local",
  });
  if (refusal) throw new ProtocolVersionError(refusal);
  const validation = validateManifest(rawManifest);
  if (!validation.valid || !validation.manifest) {
    throw new ManifestValidationError(validation.errors);
  }
  const manifest = validation.manifest;
  const appId = manifest.id;

  const existing = appRegistryRow(db, appId);
  // An already-active app falls through rather than returning early, so that
  // installing over an install *reapplies the manifest* — which is the only
  // route a manifest change has to an installed app. Every schema step below
  // carries `alwaysRun` and every one is idempotent, so the reapply is an
  // upgrade: it adds what the manifest now declares and leaves every row alone.
  //
  // What it is not is a migration. Both `createSyncableTable` and its DSQL twin
  // create `IF NOT EXISTS`, so a column whose *declared* type changed keeps its
  // physical type. On SQLite that is usually invisible — `boolean` and
  // `integer` are both INTEGER, `timestamp` and `text` are both TEXT — but a
  // change that crosses storage classes still needs a drop, and callers must
  // not report one as applied.
  const done = getCompletedSteps(db, appId, "install");
  const hmacSecret = existing?.hmacSecret ?? mintHmacSecret();

  const alwaysRun = { alwaysRun: true } as const;

  runStep(
    db,
    appId,
    "install",
    "create_app_registry_row",
    done,
    () => {
      if (existing) {
        // The row stays; its manifest is refreshed. `hmac_secret`,
        // `installed_at` and `status` are preserved — re-minting the secret
        // would strand every signer holding the old one, and the cloud
        // verifier with it.
        updateAppRegistryManifest(db, appId, manifest, options.sourceDir);
      } else {
        insertAppRegistry(db, appId, manifest, hmacSecret, options.sourceDir ?? null);
      }
    },
    alwaysRun,
  );

  runStep(
    db,
    appId,
    "install",
    "create_access_grants",
    done,
    () => {
      // Replaces the set rather than adding to it, so an upgrade narrows access
      // the moment the manifest does. Correct, and the same thing a fresh
      // install would do — but it is a behaviour change to an installed app and
      // belongs in a release note rather than in a surprise.
      insertAccessGrants(db, appId, manifest.infraRequirements.fileAccess);
    },
    alwaysRun,
  );

  runStep(
    db,
    appId,
    "install",
    "register_label_keys",
    done,
    () => {
      insertAppLabelKeys(db, appId, manifest.infraRequirements.labelKeys);
    },
    alwaysRun,
  );

  const syncable = manifest.infraRequirements.appSpecificSyncable;
  runStep(
    db,
    appId,
    "install",
    "create_syncable_tables",
    done,
    () => {
      createAppSyncableTables(db, appId, syncable.tables);
      if (syncable.files) {
        createReservedFileRecordsTable(db, appId);
      }
    },
    alwaysRun,
  );

  runStep(
    db,
    appId,
    "install",
    "register_syncable_namespace",
    done,
    () => {
      // Column types travel with the registry row for the same reason they do on
      // the DSQL side: the query parser validates a filter value against its
      // column, and it runs in the data server, which never sees a manifest.
      //
      // Data kept by an earlier uninstall becomes this install's data here:
      // `create_syncable_tables` adopted the kept tables with IF NOT EXISTS, and
      // the namespace row now names them, so the kept-data record goes in the
      // same transaction. A kept table the new manifest no longer declares stays
      // in the database unlisted, the same as a table an upgrade drops.
      inTransaction(db, () => {
        upsertAppSyncableNamespace(db, appId, appSyncableNamespaceTables(syncable), syncable.files);
        deleteRetainedAppData(db, appId);
      });
    },
    alwaysRun,
  );

  runStep(
    db,
    appId,
    "install",
    "mark_active",
    done,
    () => {
      setAppStatus(db, appId, "active");
    },
    alwaysRun,
  );

  return { appId, hmacSecret };
}

/**
 * Uninstall an app locally. Uninstall removes the app and keeps its data.
 *
 * It removes the registry row, the access grants, the label-key declarations
 * and the syncable namespace row. It keeps the app's syncable tables and its
 * `apps/<appId>/` files, and records them in `retained_app_data` so they stay
 * visible and a reinstall adopts them. Shared records and label rows the app
 * wrote also stay; they belong to the data, not the app.
 *
 * Deleting the kept data is a separate action: {@link deleteAppDataLocal}.
 * Nothing on this path deletes app data, so a caller that passes nothing can
 * never lose it.
 */
export function uninstallLocal(db: RawDatabase, appId: string): void {
  const existing = appRegistryRow(db, appId);
  if (!existing) {
    // Nothing to do, but clear any lingering step ledger from a failed
    // install attempt so a subsequent install starts clean.
    clearStepLedger(db, appId);
    return;
  }

  const done = getCompletedSteps(db, appId, "uninstall");

  runStep(db, appId, "uninstall", "mark_uninstalling", done, () => {
    setAppStatus(db, appId, "uninstalling");
  });

  runStep(db, appId, "uninstall", "revoke_access_grants", done, () => {
    deleteAccessGrants(db, appId);
  });

  // Only the *declarations* go. The label rows this app wrote survive, per the
  // "shared data outlives uninstall" principle — reinstalling re-exposes them,
  // and a reader shouldn't lose annotations because the producer was
  // temporarily removed. See deleteAppLabelKeys.
  runStep(db, appId, "uninstall", "revoke_label_keys", done, () => {
    deleteAppLabelKeys(db, appId);
  });

  // The namespace row is the only list of the app's tables, so the kept-data
  // record takes its place in one transaction. A crash between the two would
  // otherwise leave tables nothing names.
  runStep(db, appId, "uninstall", "retain_syncable_data", done, () => {
    inTransaction(db, () => {
      const ns = getAppSyncableNamespace(db, appId);
      // Every install writes a namespace row, empty for an app that declares
      // no syncable data. An empty one keeps nothing worth listing.
      if (ns && ns.tables.length > 0) {
        upsertRetainedAppData(db, {
          appId,
          name: existing.name,
          tables: ns.tables,
          filesEnabled: ns.filesEnabled,
        });
      }
      deleteAppSyncableNamespace(db, appId);
    });
  });

  runStep(db, appId, "uninstall", "delete_app_registry_row", done, () => {
    deleteAppRegistry(db, appId);
  });

  clearStepLedger(db, appId);
}

/** Deleting kept data refused because the app is installed on this node. */
export class AppInstalledError extends LocalInstallError {
  constructor(appId: string) {
    super(`${appId} is installed. Uninstall it before deleting its data.`);
    this.name = "AppInstalledError";
  }
}

/** Deleting kept data refused because this node keeps none for the app. */
export class NoRetainedDataError extends LocalInstallError {
  constructor(appId: string) {
    super(`This machine keeps no data for ${appId}.`);
    this.name = "NoRetainedDataError";
  }
}

export interface DeleteAppDataLocalOptions {
  /**
   * Delete everything under the `apps/<appId>/` object-storage prefix. The
   * installer does not know the storage adapter; the local-data-server does.
   */
  deleteFilesPrefix: (prefix: string) => Promise<void>;
  /**
   * Delete the app's per-app `sync_state` keys and upload queue. Once the rows
   * are gone, a watermark claiming the cloud holds them is false, and a
   * reinstall would never download them again.
   */
  clearSyncState: (appId: string) => void;
}

/**
 * Delete the data an uninstall kept: the app's syncable tables, its
 * `apps/<appId>/` files and its sync state on this node. The cloud copy and
 * every other node's copy stay. It writes no tombstones, so nothing it does
 * reaches a peer.
 *
 * The caller stops and drains the app's sync engine first. A drain that
 * finishes after this writes a watermark back.
 *
 * Each step is idempotent and the kept-data record goes last, so a failure
 * part-way leaves the record in place and a retry finishes the job.
 */
export async function deleteAppDataLocal(
  db: RawDatabase,
  appId: string,
  options: DeleteAppDataLocalOptions,
): Promise<void> {
  if (appRegistryRow(db, appId)) throw new AppInstalledError(appId);
  const retained = getRetainedAppData(db, appId);
  if (!retained) throw new NoRetainedDataError(appId);

  dropAppSyncableTables(
    db,
    appId,
    retained.tables.map((t) => t.name),
  );
  if (retained.filesEnabled) {
    await options.deleteFilesPrefix(`apps/${appId}/`);
  }
  options.clearSyncState(appId);
  deleteRetainedAppData(db, appId);
}

function runStep(
  db: RawDatabase,
  appId: string,
  operation: Operation,
  step: string,
  done: Set<string>,
  fn: () => void,
  opts?: { alwaysRun?: boolean },
): void {
  // Most steps are skipped once recorded "done", so a resumed install does not
  // repeat completed work. A step flagged `alwaysRun` reconciles every time
  // instead — the same option the cloud orchestrator's `runStep` carries, and
  // for the same reason: the desired state is the manifest's, and a completed
  // record is not evidence that the manifest has not changed since.
  //
  // Every step marked with it is idempotent and non-destructive by
  // construction: `CREATE TABLE`/`CREATE INDEX IF NOT EXISTS`, replaced grants,
  // upserted label keys and namespace, and a registry row whose secret is
  // preserved. That is what makes reapplying an install an upgrade rather than
  // a reinstall.
  if (!opts?.alwaysRun && done.has(step)) return;
  recordStep(db, appId, operation, step, "pending");
  try {
    fn();
    recordStep(db, appId, operation, step, "done");
    done.add(step);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordStep(db, appId, operation, step, "failed", msg);
    throw new LocalInstallError(`Install step "${step}" failed: ${msg}`, err);
  }
}

function mintHmacSecret(): string {
  return randomBytes(32).toString("hex");
}

export type { AppManifest };
