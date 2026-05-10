/**
 * Admin-side registry operations for install/uninstall tracking.
 *
 * Writes to the admin Postgres DB (app_registry, access_policies, app_install_steps)
 * using the pg pool from @starkeep/admin-db — not the per-app DSQL cluster.
 */

import {
  getPool,
  AppRegistryRepository,
  AccessPoliciesRepository,
  type CreateAppRegistryInput,
} from "@starkeep/admin-db";
import type { AppManifest, SharedTypeAccess } from "@starkeep/admin-manifest";

export type StepStatus = "pending" | "done" | "failed";

export async function recordStep(
  appId: string,
  operation: "install" | "uninstall",
  step: string,
  status: StepStatus,
  error?: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_install_steps (app_id, operation, step, status, error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_id, operation, step)
     DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, updated_at = NOW()`,
    [appId, operation, step, status, error ?? null],
  );
}

export async function getCompletedSteps(
  appId: string,
  operation: "install" | "uninstall",
): Promise<Set<string>> {
  const pool = getPool();
  const result = await pool.query<{ step: string }>(
    `SELECT step FROM app_install_steps WHERE app_id = $1 AND operation = $2 AND status = 'done'`,
    [appId, operation],
  );
  return new Set(result.rows.map((r: { step: string }) => r.step));
}

export async function registerApp(
  manifest: AppManifest,
  appId: string,
  policyIds: string[],
): Promise<void> {
  const repo = new AppRegistryRepository();
  const input: CreateAppRegistryInput = {
    app_id: appId,
    name: manifest.name,
    version: manifest.version,
    tier: "app",
    manifest: manifest as unknown as Record<string, unknown>,
    policy_ids: policyIds,
    registered_type_ids: [],
  };
  await repo.create(input);
}

export async function createAccessPolicies(
  appId: string,
  sharedTypeAccess: SharedTypeAccess[],
): Promise<string[]> {
  const repo = new AccessPoliciesRepository();
  const policyIds: string[] = [];

  for (const entry of sharedTypeAccess) {
    const permissions = entry.access === "readwrite"
      ? ["read", "write"]
      : ["read"];
    if (entry.metadataWrite) permissions.push("metadata:write");

    const policy = await repo.create({
      subject_type: "app",
      subject_id: appId,
      resource_type: "shared_type",
      resource_id: entry.typeId,
      permissions,
    });
    policyIds.push(policy.id);
  }

  return policyIds;
}

export async function revokeAccessPolicies(appId: string): Promise<void> {
  const repo = new AccessPoliciesRepository();
  const policies = await repo.findBySubject("app", appId);
  await repo.revokeAll(policies.map((p: { id: string }) => p.id));
}

export async function deleteAppRegistryEntry(appId: string): Promise<void> {
  const repo = new AppRegistryRepository();
  await repo.delete(appId);
}
