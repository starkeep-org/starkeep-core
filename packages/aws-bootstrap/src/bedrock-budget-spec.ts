/**
 * The shapes handed to the AWS Budgets API for the Bedrock spend guardrail
 * (budget-guardrail plan §4.3) — pure functions, no SDK.
 *
 * These live here, in the one package both admin-installer and admin-web already
 * depend on (and which neither may depend on the other through), because the
 * budget is created by the installer and edited by admin-web. A `CostFilters`
 * that drifted between the create path and the update path would silently
 * produce a budget that tracks the wrong spend — a guardrail that looks armed
 * and measures nothing. One definition, two callers.
 *
 * Naming is Bedrock-specific throughout, deliberately: the cost filter is
 * `Service = Amazon Bedrock` and nothing else, so a generic "capability budget"
 * name would promise coverage of a future non-Bedrock capability that this
 * budget structurally cannot give. A second brokered provider gets its own
 * budget, not a rename of this one.
 */

import { microsToUsdDecimalString, type Micros } from "@starkeep/protocol-primitives";

/** The reserved app id of the capability-broker role (mirrors admin-installer's
 * `CAPABILITY_BROKER_APP_ID`; duplicated as a literal because this package must
 * not depend on the installer). */
const CAPABILITY_BROKER_APP_ID = "capability-broker";

/** AWS's `Service` dimension value for Bedrock in Cost Explorer / Budgets. */
export const BEDROCK_COST_FILTER_SERVICE = "Amazon Bedrock";

/** Budgets is a global service: every API call goes to us-east-1, whatever
 * region the rest of the deployment lives in. A client built for the
 * deployment's own region fails at runtime and nowhere else. */
export const BUDGETS_REGION = "us-east-1";

/** Name of the monthly Bedrock spend budget. Budget names are immutable in AWS
 * (a rename is a delete + create), so this is effectively permanent. */
export function bedrockBudgetName(stackPrefix: string): string {
  return `${stackPrefix}-bedrock-spend`;
}

/** Name of the single budget action attached to that budget. */
export function bedrockFreezePolicyName(stackPrefix: string): string {
  return `${stackPrefix}-bedrock-freeze-policy`;
}

export function bedrockFreezePolicyArn(stackPrefix: string, accountId: string): string {
  return `arn:aws:iam::${accountId}:policy/${bedrockFreezePolicyName(stackPrefix)}`;
}

export function bedrockBudgetActionRoleName(stackPrefix: string): string {
  return `${stackPrefix}-bedrock-budget-action-role`;
}

export function bedrockBudgetActionRoleArn(stackPrefix: string, accountId: string): string {
  return `arn:aws:iam::${accountId}:role/${bedrockBudgetActionRoleName(stackPrefix)}`;
}

/**
 * THE roles the freeze applies to — the single source of truth for four things:
 * the budget action's `Roles[]`, the budget-action role's IAM resource scope
 * (bootstrap CFN §4.1), Manager's attach/detach scope (§4.2), and the manual
 * freeze/resume controls.
 *
 * **THIS IS THE ONE PLACE A FUTURE BEDROCK-SPENDING ROLE GETS ADDED.** Add a
 * line here and reinstall: `ensureBedrockBudget` reconciles a live action's
 * `Roles[]` against this list, so the change propagates everywhere with one
 * edit. Today there is exactly one entry — the capability-broker role is the
 * only identity in the deployment carrying any `bedrock:*` verb.
 *
 * Bare role NAMES, not ARNs: `IamActionDefinition.Roles` takes names, and an ARN
 * there is rejected at AWS and nowhere earlier.
 */
export function bedrockFreezeTargetRoleNames(stackPrefix: string): string[] {
  return [`${stackPrefix}-app-${CAPABILITY_BROKER_APP_ID}-role`];
}

/** The `Budget` shape for `CreateBudget` / `UpdateBudget`. */
export interface BedrockBudgetSpec {
  BudgetName: string;
  BudgetType: "COST";
  TimeUnit: "MONTHLY";
  BudgetLimit: { Amount: string; Unit: "USD" };
  CostFilters: { Service: string[] };
}

export function bedrockBudgetSpec(input: {
  stackPrefix: string;
  /** The monthly limit in canonical micros. Converted to AWS's
   * dollars-as-decimal-string exactly here, and nowhere else. */
  limitMicros: Micros | number;
}): BedrockBudgetSpec {
  return {
    BudgetName: bedrockBudgetName(input.stackPrefix),
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    BudgetLimit: {
      Amount: microsToUsdDecimalString(input.limitMicros as Micros),
      Unit: "USD",
    },
    CostFilters: { Service: [BEDROCK_COST_FILTER_SERVICE] },
  };
}

/** The `BudgetAction` shape for `CreateBudgetAction` / `UpdateBudgetAction`. */
export interface BedrockBudgetActionSpec {
  NotificationType: "ACTUAL";
  ActionType: "APPLY_IAM_POLICY";
  ActionThreshold: { ActionThresholdValue: number; ActionThresholdType: "PERCENTAGE" };
  ExecutionRoleArn: string;
  ApprovalModel: "AUTOMATIC";
  Subscribers: { SubscriptionType: "EMAIL"; Address: string }[];
  Definition: { IamActionDefinition: { PolicyArn: string; Roles: string[] } };
}

export function bedrockBudgetActionSpec(input: {
  stackPrefix: string;
  accountId: string;
  /** Where AWS sends the "this action executed" notice. Budgets requires at
   * least one subscriber on an action even when the action is AUTOMATIC. */
  notifyEmail: string;
}): BedrockBudgetActionSpec {
  return {
    // ACTUAL, not FORECASTED: forecast-based firing would freeze on a
    // projection, which is far too twitchy for a hard cut.
    NotificationType: "ACTUAL",
    ActionType: "APPLY_IAM_POLICY",
    ActionThreshold: { ActionThresholdValue: 100, ActionThresholdType: "PERCENTAGE" },
    ExecutionRoleArn: bedrockBudgetActionRoleArn(input.stackPrefix, input.accountId),
    // AUTOMATIC: a guardrail that waits for a human on a laptop is not a guardrail.
    ApprovalModel: "AUTOMATIC",
    Subscribers: [{ SubscriptionType: "EMAIL", Address: input.notifyEmail }],
    Definition: {
      IamActionDefinition: {
        PolicyArn: bedrockFreezePolicyArn(input.stackPrefix, input.accountId),
        Roles: bedrockFreezeTargetRoleNames(input.stackPrefix),
      },
    },
  };
}
