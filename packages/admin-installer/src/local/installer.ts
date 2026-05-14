import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  validateManifest,
  checkTypeConflicts,
  type AppManifest,
} from "@starkeep/admin-manifest";
import {
  appRegistryRow,
  clearStepLedger,
  deleteAccessGrants,
  deleteAppRegistry,
  getCompletedSteps,
  insertAccessGrants,
  insertAppRegistry,
  recordStep,
  setAppStatus,
  type Operation,
} from "./registry.js";

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
export function installLocal(db: DatabaseSync, rawManifest: unknown): InstallLocalResult {
  const validation = validateManifest(rawManifest);
  if (!validation.valid || !validation.manifest) {
    throw new ManifestValidationError(validation.errors);
  }
  const manifest = validation.manifest;
  const appId = manifest.id;

  const conflicts = checkTypeConflicts();
  if (conflicts.length > 0) {
    throw new LocalInstallError(
      `Type conflicts: ${conflicts.map((c) => `${c.typeId} (${c.reason})`).join("; ")}`,
    );
  }

  const existing = appRegistryRow(db, appId);
  if (existing && existing.status === "active") {
    // Already installed — return the existing secret so the caller can rewire
    // the app's identity without a reinstall.
    return { appId, hmacSecret: existing.hmacSecret };
  }

  const done = getCompletedSteps(db, appId, "install");
  const hmacSecret = existing?.hmacSecret ?? mintHmacSecret();

  runStep(db, appId, "install", "create_app_registry_row", done, () => {
    if (!existing) {
      insertAppRegistry(db, appId, manifest, hmacSecret);
    }
  });

  runStep(db, appId, "install", "create_access_grants", done, () => {
    insertAccessGrants(db, appId, manifest.infraRequirements.sharedTypeAccess);
  });

  runStep(db, appId, "install", "mark_active", done, () => {
    setAppStatus(db, appId, "active");
  });

  return { appId, hmacSecret };
}

/**
 * Uninstall an app locally: drops its access grants and registry row. Shared
 * records produced by the app stay behind — they belong to the data, not the
 * app — matching the cloud-side design.
 */
export function uninstallLocal(db: DatabaseSync, appId: string): void {
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

  runStep(db, appId, "uninstall", "delete_app_registry_row", done, () => {
    deleteAppRegistry(db, appId);
  });

  clearStepLedger(db, appId);
}

function runStep(
  db: DatabaseSync,
  appId: string,
  operation: Operation,
  step: string,
  done: Set<string>,
  fn: () => void,
): void {
  if (done.has(step)) return;
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
