/**
 * The per-app capability-grant model (plan §3.2), parallel to the per-type
 * access-grant model in `../access/grants.ts`.
 *
 * On install the user approves an app's declared capabilities; the installer
 * writes one `capability_grants` row per `(appId, capabilityName)` with the
 * approved `models` list and the app's declared `reports` set. The broker
 * enforces those grants on every call: no grant row → 403; a model not in the
 * approved list → 403; a gate on a non-generic dimension the app didn't declare
 * in `reports` → fail-closed deny (see `./gates.ts`).
 *
 * Pure and store-agnostic — the broker supplies the grant source (DSQL).
 */

/** A capability-grant row as the broker reads it from `shared.capability_grants`. */
export interface CapabilityGrantRow {
  appId: string;
  capabilityName: string;
  /** Approved Bedrock model ids the app may call under this capability. */
  models: readonly string[];
  /** Non-generic `"dimension:unit"` keys the app declared it can report. */
  reports: readonly string[];
}

/** A resolved snapshot of one app's grant for one capability. */
export interface CapabilityGrant {
  appId: string;
  capabilityName: string;
  models: ReadonlySet<string>;
  reports: ReadonlySet<string>;
}

export function buildCapabilityGrant(row: CapabilityGrantRow): CapabilityGrant {
  return {
    appId: row.appId,
    capabilityName: row.capabilityName,
    models: new Set(row.models),
    reports: new Set(row.reports),
  };
}

/** True if the app's grant approves invoking `modelId`. */
export function canInvokeModel(grant: CapabilityGrant, modelId: string): boolean {
  return grant.models.has(modelId);
}
