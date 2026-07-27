/**
 * The shapes handed to the AWS Budgets API (budget-guardrail plan §4.3).
 *
 * These are pure functions, but every field in them is load-bearing in a way
 * that fails SILENTLY rather than loudly: a wrong `CostFilters.Service` produces
 * a budget that tracks nothing, a `FORECASTED` notification type freezes on a
 * projection, and an ARN where a role NAME belongs is rejected at AWS and
 * nowhere earlier. So the emitted shapes are asserted field by field.
 */
import { describe, it, expect } from "vitest";
import {
  bedrockBudgetName,
  bedrockBudgetSpec,
  bedrockBudgetActionSpec,
  bedrockFreezeTargetRoleNames,
  bedrockFreezePolicyArn,
  bedrockBudgetActionRoleArn,
} from "../src/bedrock-budget-spec.js";

const PREFIX = "starkeep";
const ACCOUNT = "111122223333";
const EMAIL = "operator@example.com";
const USD = 1_000_000;

describe("bedrockBudgetName", () => {
  it("is prefix-scoped and Bedrock-specific", () => {
    expect(bedrockBudgetName(PREFIX)).toBe("starkeep-bedrock-spend");
    expect(bedrockBudgetName("teststk")).toBe("teststk-bedrock-spend");
  });
});

describe("bedrockBudgetSpec", () => {
  const spec = bedrockBudgetSpec({ stackPrefix: PREFIX, limitMicros: 25 * USD });

  it("is a monthly COST budget filtered to Bedrock alone", () => {
    expect(spec).toEqual({
      BudgetName: "starkeep-bedrock-spend",
      BudgetType: "COST",
      TimeUnit: "MONTHLY",
      BudgetLimit: { Amount: "25", Unit: "USD" },
      // The one string that decides whether this budget measures anything.
      CostFilters: { Service: ["Amazon Bedrock"] },
    });
  });

  it("converts micros to AWS's dollars-as-decimal-string", () => {
    expect(
      bedrockBudgetSpec({ stackPrefix: PREFIX, limitMicros: 12_500_000 }).BudgetLimit.Amount,
    ).toBe("12.5");
    expect(
      bedrockBudgetSpec({ stackPrefix: PREFIX, limitMicros: 1 }).BudgetLimit.Amount,
    ).toBe("0.000001");
  });

  it("rejects a negative limit rather than emitting one", () => {
    // A negative limit would be accepted by AWS as 0 or rejected at the API —
    // either way the operator's intent is lost. Fail at the boundary.
    expect(() =>
      bedrockBudgetSpec({ stackPrefix: PREFIX, limitMicros: -1 }),
    ).toThrow(RangeError);
  });
});

describe("bedrockFreezeTargetRoleNames", () => {
  it("is exactly the capability-broker role today", () => {
    expect(bedrockFreezeTargetRoleNames(PREFIX)).toEqual([
      "starkeep-app-capability-broker-role",
    ]);
  });

  it("yields bare role NAMES, never ARNs", () => {
    // IamActionDefinition.Roles takes names; an ARN there fails only at AWS.
    const names = bedrockFreezeTargetRoleNames(PREFIX);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/^arn:/);
      expect(name).not.toContain(":");
      expect(name).not.toContain("/");
    }
  });
});

describe("bedrockBudgetActionSpec", () => {
  const spec = bedrockBudgetActionSpec({
    stackPrefix: PREFIX,
    accountId: ACCOUNT,
    notifyEmail: EMAIL,
  });

  it("fires automatically at 100% of ACTUAL spend by applying the freeze policy", () => {
    expect(spec.ActionType).toBe("APPLY_IAM_POLICY");
    // AUTOMATIC: a guardrail that waits for a human is not a guardrail.
    expect(spec.ApprovalModel).toBe("AUTOMATIC");
    // ACTUAL, not FORECASTED — a hard cut must not fire on a projection.
    expect(spec.NotificationType).toBe("ACTUAL");
    expect(spec.ActionThreshold).toEqual({
      ActionThresholdValue: 100,
      ActionThresholdType: "PERCENTAGE",
    });
  });

  it("targets exactly bedrockFreezeTargetRoleNames with the freeze policy", () => {
    expect(spec.Definition.IamActionDefinition).toEqual({
      PolicyArn: bedrockFreezePolicyArn(PREFIX, ACCOUNT),
      Roles: bedrockFreezeTargetRoleNames(PREFIX),
    });
    expect(spec.ExecutionRoleArn).toBe(bedrockBudgetActionRoleArn(PREFIX, ACCOUNT));
  });

  it("carries the subscriber Budgets requires", () => {
    // CreateBudgetAction rejects an empty Subscribers list, so this is not
    // cosmetic — omitting it makes the whole guardrail uncreatable.
    expect(spec.Subscribers).toEqual([
      { SubscriptionType: "EMAIL", Address: EMAIL },
    ]);
  });
});
