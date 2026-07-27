/**
 * Install-time wiring for the Bedrock spend guardrail (budget-guardrail plan
 * §4.4 / §4.5).
 *
 * The AWS operations themselves live in `@starkeep/aws-bootstrap/bedrock-budget-ops`,
 * shared with admin-web (which cannot import this package — see admin-web's
 * next.config.ts). What lives HERE is the installer's half: resolving the
 * operator's persisted preference into concrete arguments, and the best-effort
 * wrapper step 1d runs.
 *
 * The preference is the only thing stored locally. AWS is the state: "enabled"
 * means the budget exists, and the limit and month-to-date spend come from
 * `DescribeBudget`. The file exists only so a re-install doesn't resurrect a
 * budget the operator deliberately deleted.
 */

import {
  ensureBedrockBudget,
  deleteBedrockBudget,
  type BedrockBudgetCredentials,
} from "@starkeep/aws-bootstrap/bedrock-budget-ops";
import { usdDecimalToMicros } from "@starkeep/protocol-primitives";

export {
  describeBedrockBudget,
  ensureBedrockBudget,
  deleteBedrockBudget,
  freezeBedrock,
  resumeBedrock,
  type BedrockBudgetStatus,
} from "@starkeep/aws-bootstrap/bedrock-budget-ops";

/** The `bedrockBudget` block of ~/.starkeep/config.json. */
export interface BedrockBudgetPreference {
  enabled?: boolean;
  /** Monthly limit in whole/decimal dollars, as the operator typed it. */
  limitUsd?: number;
  /** Where AWS sends the action-executed notice. Falls back to the config's
   * top-level `operatorEmail` (the Cognito address the operator signs in with). */
  notifyEmail?: string;
}

/**
 * The default limit: comfortably above hobby-scale captioning/tagging, low
 * enough that a runaway loop is caught inside one billing-lag window.
 */
export const DEFAULT_BEDROCK_BUDGET_LIMIT_USD = 25;

/**
 * The seeded soft ceiling sits at 80% of the budget default (§4.6). The two
 * layers only cohere if the software ceiling trips FIRST — an immediate 429 from
 * the broker beats a day-late structural freeze — and 80% leaves the gate room
 * to be the thing that actually stops a runaway before AWS ever notices.
 */
export const BEDROCK_COST_GATE_FRACTION_OF_BUDGET = 0.8;

export function defaultBedrockCostGateUsd(limitUsd: number): number {
  return limitUsd * BEDROCK_COST_GATE_FRACTION_OF_BUDGET;
}

export interface ResolvedBedrockBudgetPreference {
  enabled: boolean;
  limitUsd: number;
  limitMicros: number;
  notifyEmail?: string;
}

/**
 * Resolve the stored preference, defaulting an ABSENT block to enabled at $25.
 *
 * Absent-means-enabled is what turns the guardrail on for every deployment that
 * already exists, on its next install. Only an explicit `enabled: false`
 * suppresses it — the operator's deliberate opt-out survives, a config that
 * simply predates the feature does not stay unguarded.
 */
export function resolveBedrockBudgetPreference(
  pref: BedrockBudgetPreference | undefined,
  fallbackEmail?: string,
): ResolvedBedrockBudgetPreference {
  const limitUsd =
    typeof pref?.limitUsd === "number" && Number.isFinite(pref.limitUsd) && pref.limitUsd > 0
      ? pref.limitUsd
      : DEFAULT_BEDROCK_BUDGET_LIMIT_USD;
  return {
    enabled: pref?.enabled !== false,
    limitUsd,
    limitMicros: usdDecimalToMicros(limitUsd),
    notifyEmail: pref?.notifyEmail ?? fallbackEmail,
  };
}

export interface EnsureBedrockBudgetStepInput {
  stackPrefix: string;
  accountId: string;
  managerCreds: BedrockBudgetCredentials;
  preference: BedrockBudgetPreference | undefined;
  /** The operator's Cognito email, when the caller knows it. */
  operatorEmail?: string;
}

export type BedrockBudgetStepOutcome =
  | { status: "disabled" }
  | { status: "skipped"; reason: string }
  | { status: "ensured"; createdBudget: boolean; updatedLimit: boolean; createdAction: boolean; updatedAction: boolean }
  | { status: "failed"; reason: string };

/**
 * Step 1d of the cloud-data-server install: create or reconcile the guardrail.
 *
 * BEST-EFFORT BY DESIGN, matching step 1c (the Bedrock use-case form). No
 * guardrail is a reason to warn loudly, not to fail an install — a bootstrap
 * stack that predates this plan has no freeze policy for the action to reference
 * and would otherwise brick every install until the operator updates it.
 * The caller logs; this function never throws.
 */
export async function ensureBedrockBudgetStep(
  input: EnsureBedrockBudgetStepInput,
): Promise<BedrockBudgetStepOutcome> {
  const pref = resolveBedrockBudgetPreference(input.preference, input.operatorEmail);
  if (!pref.enabled) return { status: "disabled" };
  if (!pref.notifyEmail) {
    // Budgets rejects an action with no subscriber, so without an address there
    // is nothing to create. Not a failure — the operator can enable it from
    // admin-web Settings, which always knows the signed-in address.
    return {
      status: "skipped",
      reason:
        "no operator email on file (config.json has neither bedrockBudget.notifyEmail nor " +
        "operatorEmail) — enable the guardrail from admin-web Settings",
    };
  }

  try {
    const result = await ensureBedrockBudget({
      stackPrefix: input.stackPrefix,
      accountId: input.accountId,
      credentials: input.managerCreds,
      limitMicros: pref.limitMicros,
      notifyEmail: pref.notifyEmail,
    });
    return { status: "ensured", ...result };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Teardown counterpart, wired beside `deleteCapabilityBrokerRole`. Never
 * throws — a teardown that aborts on a missing budget strands everything after
 * it. */
export async function deleteBedrockBudgetStep(input: {
  stackPrefix: string;
  accountId: string;
  managerCreds: BedrockBudgetCredentials;
}): Promise<{ status: "deleted" } | { status: "failed"; reason: string }> {
  try {
    await deleteBedrockBudget({
      stackPrefix: input.stackPrefix,
      accountId: input.accountId,
      credentials: input.managerCreds,
    });
    return { status: "deleted" };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
