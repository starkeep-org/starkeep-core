/**
 * Cloud install registry — phase 2 placeholder.
 *
 * The DSQL-backed implementation (shared.app_registry, shared.app_install_steps,
 * shared.access_grants) is tracked in plans/peppy-wondering-metcalfe.md Phase 2.
 *
 * Until then, functions return empty/no-op defaults so the orchestrator can
 * complete its AWS-side steps (IAM, DSQL DDL, S3, Pulumi). Step tracking and
 * app registration are lossy — no resume on retry, no access grants recorded.
 */

import type { AppManifest, SharedTypeAccess } from "@starkeep/admin-manifest";

export type StepStatus = "pending" | "done" | "failed";

export async function recordStep(
  appId: string,
  operation: "install" | "uninstall",
  step: string,
  status: StepStatus,
  _error?: string,
): Promise<void> {
  console.log(`[registry] ${appId} ${operation}/${step} → ${status}`);
}

export async function getCompletedSteps(
  _appId: string,
  _operation: "install" | "uninstall",
): Promise<Set<string>> {
  return new Set<string>();
}

export async function registerApp(
  manifest: AppManifest,
  appId: string,
  _policyIds: string[],
): Promise<void> {
  console.log(`[registry] registered app ${appId} v${manifest.version}`);
}

export async function createAccessPolicies(
  _appId: string,
  _sharedTypeAccess: SharedTypeAccess[],
): Promise<string[]> {
  return [];
}

export async function revokeAccessPolicies(_appId: string): Promise<void> {
  console.log(`[registry] revokeAccessPolicies: no-op (phase 2)`);
}

export async function deleteAppRegistryEntry(_appId: string): Promise<void> {
  console.log(`[registry] deleteAppRegistryEntry: no-op (phase 2)`);
}
