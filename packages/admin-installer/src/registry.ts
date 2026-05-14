/**
 * Cloud install registry — phase 2 placeholder.
 *
 * The previous Postgres-backed implementation (via @starkeep/admin-db) was
 * removed. The cloud path will be reimplemented against DSQL: shared.app_registry,
 * shared.app_install_steps, and shared.access_grants — connections via DsqlSigner
 * mirroring dsql-ddl.ts. See ~/.claude/plans/peppy-wondering-metcalfe.md Phase 2.
 *
 * Until then these throw; orchestrator.ts is not exercised by any live caller.
 * Local install lives in ./local/* and does not go through this file.
 */

import type { AppManifest, SharedTypeAccess } from "@starkeep/admin-manifest";

export type StepStatus = "pending" | "done" | "failed";

function unimplemented(): never {
  throw new Error(
    "Cloud install registry not implemented yet — see Phase 2 of " +
      "plans/peppy-wondering-metcalfe.md. Use installLocal() for now.",
  );
}

export async function recordStep(
  _appId: string,
  _operation: "install" | "uninstall",
  _step: string,
  _status: StepStatus,
  _error?: string,
): Promise<void> {
  unimplemented();
}

export async function getCompletedSteps(
  _appId: string,
  _operation: "install" | "uninstall",
): Promise<Set<string>> {
  unimplemented();
}

export async function registerApp(
  _manifest: AppManifest,
  _appId: string,
  _policyIds: string[],
): Promise<void> {
  unimplemented();
}

export async function createAccessPolicies(
  _appId: string,
  _sharedTypeAccess: SharedTypeAccess[],
): Promise<string[]> {
  unimplemented();
}

export async function revokeAccessPolicies(_appId: string): Promise<void> {
  unimplemented();
}

export async function deleteAppRegistryEntry(_appId: string): Promise<void> {
  unimplemented();
}
