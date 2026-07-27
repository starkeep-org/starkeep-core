/**
 * Server-only access to the Bedrock spend guardrail (budget-guardrail plan
 * §4.7).
 *
 * Two responsibilities, both thin:
 *
 *   1. ASSUME MANAGER. Budget management goes through Manager, not the admin-app
 *      role. Manager is already the deployment's hub for account-global
 *      foundational setup and holds no data-plane power, so putting the budgets
 *      verbs there costs nothing and keeps admin from being a superuser. The
 *      admin-app role's policy already permits this assume.
 *   2. READ/WRITE THE OPERATOR PREFERENCE in ~/.starkeep/config.json. The file is
 *      ONLY a "should a future install recreate this?" record — AWS is the live
 *      truth. Enabling writes both; disabling writes both.
 *
 * The AWS operations themselves come from `@starkeep/aws-bootstrap`, shared with
 * the installer so the create path and the edit path cannot drift on what the
 * budget actually measures. Deliberately does NOT import
 * `@starkeep/admin-installer`, which transitively pulls Pulumi and OOMs the dev
 * bundle (see next.config.ts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { starkeepDir } from "@starkeep/app-client";
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  describeBedrockBudget,
  ensureBedrockBudget,
  deleteBedrockBudget,
  freezeBedrock,
  resumeBedrock,
  type BedrockBudgetCredentials,
  type BedrockBudgetStatus,
} from "@starkeep/aws-bootstrap/bedrock-budget-ops";
import { usdDecimalToMicros } from "@starkeep/protocol-primitives";

const CONFIG_PATH = join(starkeepDir(), "config.json");

/** Default limit and gate fraction — kept in step with the installer's
 * `bedrock-budget.ts`. Duplicated as literals rather than imported because
 * admin-web must not depend on admin-installer. */
export const DEFAULT_BEDROCK_BUDGET_LIMIT_USD = 25;
export const BEDROCK_COST_GATE_FRACTION_OF_BUDGET = 0.8;

export interface BedrockBudgetPreference {
  enabled?: boolean;
  limitUsd?: number;
  notifyEmail?: string;
}

interface StarkeepConfig {
  stackPrefix?: string;
  accountId?: string;
  userPoolId?: string;
  managerRoleArn?: string;
  operatorEmail?: string;
  bedrockBudget?: BedrockBudgetPreference;
}

/** A failure that maps to an HTTP response. Mirrors DsqlAdminError. */
export class BedrockBudgetError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BedrockBudgetError";
    this.status = status;
  }
}

export interface OperatorCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export function readStarkeepConfig(): StarkeepConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new BedrockBudgetError("Cloud is not configured; finish cloud setup first", 400);
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as StarkeepConfig;
  } catch {
    throw new BedrockBudgetError("config.json is not valid JSON", 500);
  }
}

/** Merge a `bedrockBudget` patch into config.json, preserving everything else. */
export function writeBedrockBudgetPreference(patch: BedrockBudgetPreference): void {
  const config = readStarkeepConfig();
  const merged: StarkeepConfig = {
    ...config,
    bedrockBudget: { ...(config.bedrockBudget ?? {}), ...patch },
  };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
}

/** The stored preference with the absent-means-enabled default applied. */
export function resolvePreference(config: StarkeepConfig): {
  enabled: boolean;
  limitUsd: number;
  notifyEmail?: string;
} {
  const pref = config.bedrockBudget;
  const limitUsd =
    typeof pref?.limitUsd === "number" && Number.isFinite(pref.limitUsd) && pref.limitUsd > 0
      ? pref.limitUsd
      : DEFAULT_BEDROCK_BUDGET_LIMIT_USD;
  return {
    enabled: pref?.enabled !== false,
    limitUsd,
    notifyEmail: pref?.notifyEmail ?? config.operatorEmail,
  };
}

function regionFromUserPoolId(userPoolId: string | undefined): string | null {
  return userPoolId?.split("_")[0] || null;
}

/** The deployment identity every operation below needs. */
export interface BudgetContext {
  stackPrefix: string;
  accountId: string;
  managerCreds: BedrockBudgetCredentials;
  config: StarkeepConfig;
}

/**
 * Assume Manager with the session's admin credentials and return everything the
 * budget operations need. Throws {@link BedrockBudgetError} on any config or
 * credential problem, so routes can map it straight to a status.
 */
export async function assumeManagerForBudget(
  creds: Partial<OperatorCreds>,
): Promise<BudgetContext> {
  const config = readStarkeepConfig();
  const stackPrefix = config.stackPrefix;
  const region = regionFromUserPoolId(config.userPoolId);
  if (!stackPrefix || !region) {
    throw new BedrockBudgetError(
      "config.json is missing required fields (stackPrefix, userPoolId); finish cloud setup first",
      400,
    );
  }
  if (!creds.accessKeyId || !creds.secretAccessKey || !creds.sessionToken) {
    throw new BedrockBudgetError("accessKeyId, secretAccessKey, sessionToken required", 400);
  }

  const sts = new STSClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });

  let accountId = config.accountId;
  if (!accountId) {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Account) {
      throw new BedrockBudgetError("Could not determine the AWS account id", 500);
    }
    accountId = identity.Account;
  }

  const managerRoleArn =
    config.managerRoleArn ?? `arn:aws:iam::${accountId}:role/${stackPrefix}-manager-role`;

  let assumed;
  try {
    assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: managerRoleArn,
        RoleSessionName: "starkeep-admin-bedrock-budget",
      }),
    );
  } catch (err) {
    throw new BedrockBudgetError(
      `Could not assume the Manager role (${managerRoleArn}): ` +
        (err instanceof Error ? err.message : String(err)),
      502,
    );
  }
  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new BedrockBudgetError("Manager assume returned no credentials", 502);
  }

  return {
    stackPrefix,
    accountId,
    managerCreds: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    },
    config,
  };
}

// ---------------------------------------------------------------------------
// The five operations the edit route exposes, plus status
// ---------------------------------------------------------------------------

export interface BedrockBudgetView extends BedrockBudgetStatus {
  /** The operator's persisted preference. `exists: false` with `enabled: true`
   * means an install that failed to create the budget — a different problem from
   * an operator who turned it off, and the UI must not render them the same. */
  preferenceEnabled: boolean;
  preferenceLimitUsd: number;
  /** True when the freeze policy is attached to any target role. */
  frozen: boolean;
  /** When a freeze would self-clear on its own: the start of the next billing
   * month. Budgets detaches an action-applied policy at the period rollover, so
   * Resume means "lift it early", not "the only way out". */
  selfClearsAt: string;
  /** The limit of the seeded global cost gate, in whole dollars, when one is
   * present — shown BESIDE the budget limit because the two are independent and
   * only cohere by default (§4.6). */
  globalCostGateUsd: number | null;
}

export async function getBedrockBudgetView(
  ctx: BudgetContext,
  globalCostGateUsd: number | null,
): Promise<BedrockBudgetView> {
  const status = await describeBedrockBudget({
    stackPrefix: ctx.stackPrefix,
    accountId: ctx.accountId,
    credentials: ctx.managerCreds,
  });
  const pref = resolvePreference(ctx.config);
  return {
    ...status,
    preferenceEnabled: pref.enabled,
    preferenceLimitUsd: pref.limitUsd,
    frozen: status.frozenRoleNames.length > 0,
    selfClearsAt: nextBillingMonthStart().toISOString(),
    globalCostGateUsd,
  };
}

/** Start of the next calendar month, UTC — when AWS resets the budget period
 * and, with it, detaches a freeze. */
export function nextBillingMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export async function enableBedrockBudget(
  ctx: BudgetContext,
  limitUsd?: number,
): Promise<void> {
  const pref = resolvePreference(ctx.config);
  const effectiveLimit = limitUsd ?? pref.limitUsd;
  if (!pref.notifyEmail) {
    throw new BedrockBudgetError(
      "No operator email on file to notify. Sign in again, or set bedrockBudget.notifyEmail " +
        "in ~/.starkeep/config.json — AWS requires a subscriber on a budget action.",
      400,
    );
  }
  // AWS first, then the file: the file records only what a FUTURE install should
  // do, so persisting a preference we failed to apply would be a lie.
  await ensureBedrockBudget({
    stackPrefix: ctx.stackPrefix,
    accountId: ctx.accountId,
    credentials: ctx.managerCreds,
    limitMicros: usdDecimalToMicros(effectiveLimit),
    notifyEmail: pref.notifyEmail,
  });
  writeBedrockBudgetPreference({ enabled: true, limitUsd: effectiveLimit });
}

export async function disableBedrockBudget(ctx: BudgetContext): Promise<void> {
  await deleteBedrockBudget({
    stackPrefix: ctx.stackPrefix,
    accountId: ctx.accountId,
    credentials: ctx.managerCreds,
  });
  // Persisted so the next install doesn't resurrect a budget the operator
  // deliberately removed.
  writeBedrockBudgetPreference({ enabled: false });
}

export async function freeze(ctx: BudgetContext) {
  return freezeBedrock({
    stackPrefix: ctx.stackPrefix,
    accountId: ctx.accountId,
    credentials: ctx.managerCreds,
  });
}

export async function resume(ctx: BudgetContext) {
  return resumeBedrock({
    stackPrefix: ctx.stackPrefix,
    accountId: ctx.accountId,
    credentials: ctx.managerCreds,
  });
}
