import type { RawDatabase } from "@starkeep/storage-adapter";
import { randomBytes } from "node:crypto";
import {
  validateManifest,
  type AppManifest,
} from "@starkeep/admin-manifest";
import {
  appRegistryRow,
  clearStepLedger,
  createAppSyncableTables,
  createReservedFileRecordsTable,
  deleteAccessGrants,
  deleteAppLabelKeys,
  deleteAppRegistry,
  dropAppSyncableTables,
  getCompletedSteps,
  insertAccessGrants,
  insertAppLabelKeys,
  insertAppRegistry,
  updateAppRegistryManifest,
  recordStep,
  setAppStatus,
  type Operation,
} from "./registry.js";
import {
  deleteAppSyncableNamespace,
  getAppSyncableNamespace,
  upsertAppSyncableNamespace,
} from "@starkeep/storage-sqlite";
import { FILE_RECORDS_TABLE_INFO, appSyncableTableInfo } from "@starkeep/shared-space-api";

export interface InstallLocalResult {
  appId: string;
  hmacSecret: string;
}

export class LocalInstallError extends Error {
  constructor(message: string, readonly cause?: unknown) {
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

/**
 * Install an app locally: registers it in shared_app_registry, mints an HMAC
 * secret, and writes per-type rows into shared_access_grants. Idempotent and
 * resumable via the shared_app_install_steps ledger.
 *
 * Returns the new (or existing) HMAC secret so the caller can hand it to the
 * app process for request signing.
 */
export function installLocal(db: RawDatabase, rawManifest: unknown): InstallLocalResult {
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
        updateAppRegistryManifest(db, appId, manifest);
      } else {
        insertAppRegistry(db, appId, manifest, hmacSecret);
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

  runStep(db, appId, "install", "register_syncable_namespace", done, () => {
    // Column types travel with the registry row for the same reason they do on
    // the DSQL side: the query parser validates a filter value against its
    // column, and it runs in the data server, which never sees a manifest.
    const declaredTables = syncable.tables.map((t) => appSyncableTableInfo(t.name, t.columns));
    const tables = syncable.files
      ? [...declaredTables, FILE_RECORDS_TABLE_INFO]
      : declaredTables;
    upsertAppSyncableNamespace(db, appId, tables, syncable.files);
  }, alwaysRun);

  runStep(db, appId, "install", "mark_active", done, () => {
    setAppStatus(db, appId, "active");
  }, alwaysRun);

  return { appId, hmacSecret };
}

/**
 * Uninstall an app locally: drops its access grants and registry row. Shared
 * records produced by the app stay behind — they belong to the data, not the
 * app — matching the cloud-side design.
 */
export interface UninstallLocalOptions {
  /**
   * Called with the `apps/<appId>/syncable/` prefix so the caller can delete
   * any object-storage entries for the uninstalled app. The installer itself
   * doesn't know about the storage adapter; the local-data-server wires this
   * up. Errors here don't roll back the uninstall — the DB cleanup is
   * authoritative — but they are logged.
   */
  deleteFilesPrefix?: (prefix: string) => void | Promise<void>;
  /**
   * Remove the app without removing what it holds. The app's syncable tables
   * and its app-private blobs both survive, so reinstalling the same app id
   * finds its rows and files where it left them — which is what makes a
   * major-version upgrade expressible. The declarations still go: the registry
   * row, the access grants, the label keys and the syncable namespace. Table
   * creation is `IF NOT EXISTS`, so the reinstall adopts the retained tables
   * rather than failing on them.
   */
  retainData?: boolean;
}

export function uninstallLocal(
  db: RawDatabase,
  appId: string,
  options: UninstallLocalOptions = {},
): void {
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

  // The two steps that destroy what the app holds. `retainData` skips both,
  // and nothing below them reads a table or a blob, so the rest of the
  // uninstall proceeds unchanged.
  if (!options.retainData) {
    runStep(db, appId, "uninstall", "drop_syncable_tables", done, () => {
      const ns = getAppSyncableNamespace(db, appId);
      if (ns) dropAppSyncableTables(db, appId, ns.tableNames);
    });

    runStep(db, appId, "uninstall", "delete_syncable_files", done, () => {
      const ns = getAppSyncableNamespace(db, appId);
      if (ns?.filesEnabled && options.deleteFilesPrefix) {
        deleteFilesPrefix(options.deleteFilesPrefix, `apps/${appId}/syncable/`);
      }
    });
  }

  runStep(db, appId, "uninstall", "delete_syncable_namespace", done, () => {
    deleteAppSyncableNamespace(db, appId);
  });

  runStep(db, appId, "uninstall", "delete_app_registry_row", done, () => {
    deleteAppRegistry(db, appId);
  });

  clearStepLedger(db, appId);
}

export interface RemoveAppFromNodeOptions {
  /**
   * Called with the `apps/<appId>/` prefix so the caller can delete this
   * node's object-storage entries for the app. Wider than the uninstall's
   * `apps/<appId>/syncable/` on purpose: a node-local removal is meant to
   * reclaim everything the app put on this machine, not only the part the sync
   * engine manages. Errors are logged and do not roll the removal back.
   */
  deleteFilesPrefix?: (prefix: string) => void | Promise<void>;
  /**
   * Called to delete this app's `sync_state` rows. The installer does not own
   * the key scheme — the local-data-server's per-app sync state store does —
   * so the caller supplies the deletion, the way it supplies blob deletion.
   *
   * Not optional in practice, and the single step in this operation that is
   * easiest to omit. A removal that leaves the watermark behind reinstalls
   * into a node that believes it has already read everything the cloud holds,
   * so the app comes back empty and stays empty: the puller asks for changes
   * after a point the cloud has long passed, and no later round ever goes back
   * for the rows in between.
   */
  clearSyncState?: () => void;
}

/**
 * Remove this node's copy of an app and propagate nothing.
 *
 * The distinction from `uninstallLocal` is what reaches the other nodes.
 * Uninstalling is a statement about the app; removing from a node is a
 * statement about this machine's disk, and the cloud's rows, the other
 * desktops' rows and the handset's rows all stay exactly as they are. Dropping
 * a syncable table writes no tombstone — the applier only ships rows it is
 * asked to write — so nothing about this removal is observable to a peer.
 *
 * Reinstalling afterwards refills the node from the cloud, which is the whole
 * point and the reason `clearSyncState` is part of the operation rather than a
 * refinement of it.
 */
export function removeAppFromNode(
  db: RawDatabase,
  appId: string,
  options: RemoveAppFromNodeOptions = {},
): void {
  const existing = appRegistryRow(db, appId);
  if (!existing) {
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

  runStep(db, appId, "uninstall", "revoke_label_keys", done, () => {
    deleteAppLabelKeys(db, appId);
  });

  runStep(db, appId, "uninstall", "drop_syncable_tables", done, () => {
    const ns = getAppSyncableNamespace(db, appId);
    if (ns) dropAppSyncableTables(db, appId, ns.tableNames);
  });

  runStep(db, appId, "uninstall", "delete_node_files", done, () => {
    if (options.deleteFilesPrefix) {
      deleteFilesPrefix(options.deleteFilesPrefix, `apps/${appId}/`);
    }
  });

  // Ordered after the tables and the blobs so a failure part-way through
  // leaves a node that still knows where it had read up to. Clearing the
  // watermark first and then failing to drop the tables would leave the node
  // re-applying rows it already holds.
  runStep(db, appId, "uninstall", "clear_sync_state", done, () => {
    options.clearSyncState?.();
  });

  runStep(db, appId, "uninstall", "delete_syncable_namespace", done, () => {
    deleteAppSyncableNamespace(db, appId);
  });

  runStep(db, appId, "uninstall", "delete_app_registry_row", done, () => {
    deleteAppRegistry(db, appId);
  });

  clearStepLedger(db, appId);
}

/**
 * Hand a prefix to the caller's deleter, tolerating both a synchronous and an
 * asynchronous one. The step ledger is synchronous, so an async deletion is
 * fire-and-forget with its failure logged rather than awaited — the database
 * cleanup is what is authoritative.
 */
function deleteFilesPrefix(
  deleter: (prefix: string) => void | Promise<void>,
  prefix: string,
): void {
  try {
    const result = deleter(prefix);
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) =>
        console.error(`uninstall: failed to clear ${prefix}:`, err),
      );
    }
  } catch (err) {
    console.error(`uninstall: failed to clear ${prefix}:`, err);
  }
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
