/**
 * The AWS-side operations behind the Bedrock spend guardrail (budget-guardrail
 * plan §4.4) — create/repair, delete, describe, freeze, resume.
 *
 * SERVER-ONLY. This module is reachable at `@starkeep/aws-bootstrap/bedrock-budget-ops`
 * rather than from the package index on purpose: the index is imported by
 * admin-web's client-side setup wizard, and pulling the Budgets/IAM SDKs in
 * there would drag two AWS clients into the browser bundle for no reason.
 *
 * WHY IT LIVES HERE rather than in admin-installer. Both callers need it: the
 * installer creates the budget during the cloud-data-server foundational install,
 * and admin-web toggles/re-prices/freezes it from Settings. admin-web must NOT
 * import admin-installer (that pulls @pulumi/* into the dev bundle and OOMs the
 * dev server — see admin-web's next.config.ts), and neither app may depend on
 * the other, so this package is the one place both can share the implementation.
 * That matters here beyond taste: a create path and an update path that had
 * drifted on `CostFilters` would produce a budget that looks armed and measures
 * nothing.
 *
 * Every call is idempotent and every call goes to us-east-1 — Budgets is a
 * global service, and a client built for the deployment's own region fails at
 * runtime and nowhere else.
 */

import {
  BudgetsClient,
  CreateBudgetCommand,
  CreateBudgetActionCommand,
  DeleteBudgetCommand,
  DeleteBudgetActionCommand,
  DescribeBudgetCommand,
  DescribeBudgetActionsForBudgetCommand,
  DescribeBudgetActionHistoriesCommand,
  ExecuteBudgetActionCommand,
  UpdateBudgetCommand,
  UpdateBudgetActionCommand,
  type Action,
} from "@aws-sdk/client-budgets";
import {
  IAMClient,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
} from "@aws-sdk/client-iam";
import { usdDecimalToMicros } from "@starkeep/protocol-primitives";
import {
  BUDGETS_REGION,
  bedrockBudgetActionSpec,
  bedrockBudgetName,
  bedrockBudgetSpec,
  bedrockFreezePolicyArn,
  bedrockFreezeTargetRoleNames,
} from "./bedrock-budget-spec.js";

export interface BedrockBudgetCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface BedrockBudgetTarget {
  stackPrefix: string;
  accountId: string;
  /** Manager-role credentials. Manager is the deployment's hub for
   * account-global foundational setup and holds the budgets verbs; the
   * admin-app role does not. */
  credentials: BedrockBudgetCredentials;
}

function budgetsClient(creds: BedrockBudgetCredentials): BudgetsClient {
  return new BudgetsClient({ region: BUDGETS_REGION, credentials: creds });
}

function iamClient(creds: BedrockBudgetCredentials): IAMClient {
  // IAM is global; the region only decides which endpoint is dialled.
  return new IAMClient({ region: BUDGETS_REGION, credentials: creds });
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "NotFoundException" || name === "NoSuchEntityException";
}

/** Micros for a Budgets `Spend`/`BudgetLimit` amount, or null when absent. */
function spendMicros(amount: string | undefined): number | null {
  if (amount === undefined) return null;
  try {
    return usdDecimalToMicros(amount);
  } catch {
    // A limit we cannot parse must not read as $0 — that would render an
    // unbounded budget as the tightest one in the UI.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Action lifecycle values that mean the freeze policy has been (or is being)
 * applied by Budgets. `STANDBY` means armed-but-not-fired; the reverse/reset
 * statuses mean it has been lifted. */
const EXECUTED_ACTION_STATUSES = new Set([
  "PENDING",
  "EXECUTION_IN_PROGRESS",
  "EXECUTION_SUCCESS",
]);

export interface BedrockBudgetStatus {
  /** Whether the budget exists in AWS. AWS is the state — there is no table. */
  exists: boolean;
  /** Monthly limit, in canonical micros. */
  limitMicros: number | null;
  /** Month-to-date and forecast Bedrock spend, in canonical micros. */
  actualSpendMicros: number | null;
  forecastedSpendMicros: number | null;
  /** The budget action, when one is attached. `actionId` being null with
   * `exists: true` is the half-built state a failed install can leave. */
  actionId: string | null;
  actionStatus: string | null;
  /** Roles that currently have the freeze policy attached — read live from IAM,
   * NEVER from a cached "we froze it" flag. Two reasons: a freeze self-clears at
   * the month boundary (§3), so a cached flag leaves a stale banner claiming
   * apps are broken when they aren't; and a manual Freeze-now doesn't move the
   * action's status at all, so action status alone would miss it. */
  frozenRoleNames: string[];
  /** Every role the freeze targets, frozen or not. */
  targetRoleNames: string[];
  /** When Budgets last executed the action (ISO), if it ever has. */
  lastExecuted: string | null;
}

export async function describeBedrockBudget(
  input: BedrockBudgetTarget,
): Promise<BedrockBudgetStatus> {
  const { stackPrefix, accountId, credentials } = input;
  const budgets = budgetsClient(credentials);
  const budgetName = bedrockBudgetName(stackPrefix);
  const targetRoleNames = bedrockFreezeTargetRoleNames(stackPrefix);

  // Attachment state is meaningful even when the budget is gone: an operator can
  // disable the budget while a freeze is still applied, and a UI that then
  // reported "not frozen" would be lying about why apps are failing.
  const frozenRoleNames = await listFrozenRoles(input);

  let budget;
  try {
    const res = await budgets.send(
      new DescribeBudgetCommand({ AccountId: accountId, BudgetName: budgetName }),
    );
    budget = res.Budget;
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return {
      exists: false,
      limitMicros: null,
      actualSpendMicros: null,
      forecastedSpendMicros: null,
      actionId: null,
      actionStatus: null,
      frozenRoleNames,
      targetRoleNames,
      lastExecuted: null,
    };
  }

  const action = await findBudgetAction(input);
  return {
    exists: true,
    limitMicros: spendMicros(budget?.BudgetLimit?.Amount),
    actualSpendMicros: spendMicros(budget?.CalculatedSpend?.ActualSpend?.Amount),
    forecastedSpendMicros: spendMicros(budget?.CalculatedSpend?.ForecastedSpend?.Amount),
    actionId: action?.ActionId ?? null,
    actionStatus: action?.Status ?? null,
    frozenRoleNames,
    targetRoleNames,
    lastExecuted: action ? await lastExecutedAt(input, action.ActionId!) : null,
  };
}

/** The roles that currently carry the freeze policy. */
async function listFrozenRoles(input: BedrockBudgetTarget): Promise<string[]> {
  const { stackPrefix, accountId, credentials } = input;
  const iam = iamClient(credentials);
  const policyArn = bedrockFreezePolicyArn(stackPrefix, accountId);
  const frozen: string[] = [];
  for (const roleName of bedrockFreezeTargetRoleNames(stackPrefix)) {
    try {
      const res = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
      if ((res.AttachedPolicies ?? []).some((p) => p.PolicyArn === policyArn)) {
        frozen.push(roleName);
      }
    } catch (err) {
      // A role that doesn't exist yet (pre-install) is simply not frozen.
      if (!isNotFound(err)) throw err;
    }
  }
  return frozen;
}

async function findBudgetAction(input: BedrockBudgetTarget): Promise<Action | undefined> {
  const { stackPrefix, accountId, credentials } = input;
  try {
    const res = await budgetsClient(credentials).send(
      new DescribeBudgetActionsForBudgetCommand({
        AccountId: accountId,
        BudgetName: bedrockBudgetName(stackPrefix),
      }),
    );
    return (res.Actions ?? [])[0];
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

async function lastExecutedAt(
  input: BedrockBudgetTarget,
  actionId: string,
): Promise<string | null> {
  const { stackPrefix, accountId, credentials } = input;
  try {
    const res = await budgetsClient(credentials).send(
      new DescribeBudgetActionHistoriesCommand({
        AccountId: accountId,
        BudgetName: bedrockBudgetName(stackPrefix),
        ActionId: actionId,
      }),
    );
    const executions = (res.ActionHistories ?? []).filter(
      (h) => h.Status && EXECUTED_ACTION_STATUSES.has(h.Status),
    );
    const latest = executions
      .map((h) => h.Timestamp)
      .filter((t): t is Date => t instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return latest ? latest.toISOString() : null;
  } catch {
    // History is decoration on the banner, not the banner's truth. Never let it
    // fail the status read.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Create / repair / delete
// ---------------------------------------------------------------------------

export interface EnsureBedrockBudgetInput extends BedrockBudgetTarget {
  /** Monthly limit in canonical micros. */
  limitMicros: number;
  /** Where AWS sends the action-executed notice. Budgets rejects an action with
   * no subscriber, so this is required to create one. */
  notifyEmail: string;
}

export interface EnsureBedrockBudgetResult {
  createdBudget: boolean;
  updatedLimit: boolean;
  createdAction: boolean;
  updatedAction: boolean;
}

/**
 * Create the budget + action, or bring an existing pair back into line.
 *
 * Four distinct repairs, because each corresponds to a state a real deployment
 * reaches: a fresh account (create both), an operator re-priced limit (update
 * the budget), a half-built pair left by a run that failed between the two
 * creates (create only the action), and a `Roles[]` that no longer matches
 * `bedrockFreezeTargetRoleNames` (update the action — this is the reconcile that
 * makes adding a future Bedrock-spending role a one-line change, per §4.3).
 */
export async function ensureBedrockBudget(
  input: EnsureBedrockBudgetInput,
): Promise<EnsureBedrockBudgetResult> {
  const { stackPrefix, accountId, credentials, limitMicros, notifyEmail } = input;
  const budgets = budgetsClient(credentials);
  const budgetName = bedrockBudgetName(stackPrefix);
  const spec = bedrockBudgetSpec({ stackPrefix, limitMicros });
  const result: EnsureBedrockBudgetResult = {
    createdBudget: false,
    updatedLimit: false,
    createdAction: false,
    updatedAction: false,
  };

  let live;
  try {
    const res = await budgets.send(
      new DescribeBudgetCommand({ AccountId: accountId, BudgetName: budgetName }),
    );
    live = res.Budget;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  if (!live) {
    await budgets.send(new CreateBudgetCommand({ AccountId: accountId, Budget: spec }));
    result.createdBudget = true;
  } else if (spendMicros(live.BudgetLimit?.Amount) !== limitMicros) {
    await budgets.send(new UpdateBudgetCommand({ AccountId: accountId, NewBudget: spec }));
    result.updatedLimit = true;
  }

  const actionSpec = bedrockBudgetActionSpec({ stackPrefix, accountId, notifyEmail });
  const existing = result.createdBudget ? undefined : await findBudgetAction(input);

  if (!existing) {
    await budgets.send(
      new CreateBudgetActionCommand({
        AccountId: accountId,
        BudgetName: budgetName,
        ...actionSpec,
      }),
    );
    result.createdAction = true;
  } else if (!sameRoles(existing, actionSpec.Definition.IamActionDefinition.Roles)) {
    await budgets.send(
      new UpdateBudgetActionCommand({
        AccountId: accountId,
        BudgetName: budgetName,
        ActionId: existing.ActionId,
        Definition: actionSpec.Definition,
      }),
    );
    result.updatedAction = true;
  }

  return result;
}

function sameRoles(action: Action, wanted: string[]): boolean {
  const live = action.Definition?.IamActionDefinition?.Roles ?? [];
  return live.length === wanted.length && wanted.every((r) => live.includes(r));
}

/**
 * Remove the budget and its action. The action goes FIRST — AWS refuses to
 * delete a budget that still has one. `NotFound` on either is a no-op, so this
 * is safe to call on a deployment that never had a guardrail and safe to call
 * twice.
 */
export async function deleteBedrockBudget(input: BedrockBudgetTarget): Promise<void> {
  const { stackPrefix, accountId, credentials } = input;
  const budgets = budgetsClient(credentials);
  const budgetName = bedrockBudgetName(stackPrefix);

  try {
    const res = await budgets.send(
      new DescribeBudgetActionsForBudgetCommand({
        AccountId: accountId,
        BudgetName: budgetName,
      }),
    );
    for (const action of res.Actions ?? []) {
      try {
        await budgets.send(
          new DeleteBudgetActionCommand({
            AccountId: accountId,
            BudgetName: budgetName,
            ActionId: action.ActionId,
          }),
        );
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  try {
    await budgets.send(
      new DeleteBudgetCommand({ AccountId: accountId, BudgetName: budgetName }),
    );
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Manual freeze / resume
// ---------------------------------------------------------------------------

/**
 * Apply the freeze now, without waiting for a breach.
 *
 * Always a direct `AttachRolePolicy` — there is no "execute early" on a budget
 * action, and attaching is what a breach would do anyway. Iterates
 * `bedrockFreezeTargetRoleNames` so it stays correct if the list grows.
 */
export async function freezeBedrock(input: BedrockBudgetTarget): Promise<string[]> {
  const { stackPrefix, accountId, credentials } = input;
  const iam = iamClient(credentials);
  const policyArn = bedrockFreezePolicyArn(stackPrefix, accountId);
  const frozen: string[] = [];
  for (const roleName of bedrockFreezeTargetRoleNames(stackPrefix)) {
    // AttachRolePolicy is idempotent — re-attaching an attached policy succeeds.
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
    frozen.push(roleName);
  }
  return frozen;
}

export interface ResumeResult {
  /** How the freeze was lifted. `reverse` keeps Budgets' own state machine
   * coherent; `detach` is the fallback (and the only option for a freeze the
   * operator applied by hand, which never moved the action's status). */
  via: "reverse" | "detach";
  roleNames: string[];
  /** Set when a preferred `reverse` failed and the detach fallback ran. Surfaced
   * rather than swallowed: "Resume did nothing and said nothing" is the worst
   * outcome this control has. */
  reverseError?: string;
}

/**
 * Lift the freeze.
 *
 * Prefers `ExecuteBudgetAction(REVERSE_BUDGET_ACTION)` when Budgets reports the
 * action as executed, so Budgets' own lifecycle (`Completed` → `Reversed`) stays
 * coherent. Falls back to a direct `DetachRolePolicy` when the action never
 * fired (a manual freeze), when there is no action at all, or when the reverse
 * call itself fails.
 *
 * Note this lifts the freeze EARLY. A freeze is self-clearing at the month
 * boundary — a budget-action-applied policy is detached at the start of the next
 * budget period and the action resets to `Standby` — so Resume is not the only
 * way out, and the UI should not imply that it is.
 */
export async function resumeBedrock(input: BedrockBudgetTarget): Promise<ResumeResult> {
  const { stackPrefix, accountId, credentials } = input;
  const action = await findBudgetAction(input);

  if (action?.ActionId && action.Status && EXECUTED_ACTION_STATUSES.has(action.Status)) {
    try {
      await budgetsClient(credentials).send(
        new ExecuteBudgetActionCommand({
          AccountId: accountId,
          BudgetName: bedrockBudgetName(stackPrefix),
          ActionId: action.ActionId,
          ExecutionType: "REVERSE_BUDGET_ACTION",
        }),
      );
      return { via: "reverse", roleNames: bedrockFreezeTargetRoleNames(stackPrefix) };
    } catch (err) {
      const reverseError = err instanceof Error ? err.message : String(err);
      return { via: "detach", roleNames: await detachFreeze(input), reverseError };
    }
  }

  return { via: "detach", roleNames: await detachFreeze(input) };
}

async function detachFreeze(input: BedrockBudgetTarget): Promise<string[]> {
  const { stackPrefix, accountId, credentials } = input;
  const iam = iamClient(credentials);
  const policyArn = bedrockFreezePolicyArn(stackPrefix, accountId);
  const detached: string[] = [];
  for (const roleName of bedrockFreezeTargetRoleNames(stackPrefix)) {
    try {
      await iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
      detached.push(roleName);
    } catch (err) {
      // Already detached (or the role is gone) is the desired end state.
      if (!isNotFound(err)) throw err;
    }
  }
  return detached;
}
