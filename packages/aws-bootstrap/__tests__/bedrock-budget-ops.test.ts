/**
 * `bedrock-budget-ops.ts` — the AWS-side operations behind the Bedrock spend
 * guardrail (budget-guardrail plan §4.4, tests per §8.1).
 *
 * Explicit non-goal: nothing here breaches a real AWS Budget. Whether Budgets
 * fires an action at 100% of actual spend is AWS's function, not ours — a test
 * for it would cost real money, take a day to return a verdict, and assert
 * something we could not fix if it failed. What IS ours is covered here: the
 * shapes we hand AWS, the repair/reconcile logic, and the freeze/resume paths.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
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
  NotFoundException,
} from "@aws-sdk/client-budgets";
import {
  IAMClient,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  NoSuchEntityException,
} from "@aws-sdk/client-iam";
import {
  describeBedrockBudget,
  ensureBedrockBudget,
  deleteBedrockBudget,
  freezeBedrock,
  resumeBedrock,
} from "../src/bedrock-budget-ops.js";

const budgetsMock = mockClient(BudgetsClient);
const iamMock = mockClient(IAMClient);

const PREFIX = "starkeep";
const ACCOUNT = "111122223333";
const EMAIL = "operator@example.com";
const BUDGET_NAME = "starkeep-bedrock-spend";
const BROKER_ROLE = "starkeep-app-capability-broker-role";
const FREEZE_POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/starkeep-bedrock-freeze-policy`;
const USD = 1_000_000;

const target = {
  stackPrefix: PREFIX,
  accountId: ACCOUNT,
  credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" },
};

function notFound(): NotFoundException {
  return new NotFoundException({ $metadata: {}, message: "not found" });
}

function noSuchEntity(): NoSuchEntityException {
  return new NoSuchEntityException({ $metadata: {}, message: "no such entity" });
}

/** A live budget as DescribeBudget returns it. */
function liveBudget(limit: string, actual = "3.5", forecast = "9.25") {
  return {
    Budget: {
      BudgetName: BUDGET_NAME,
      BudgetType: "COST" as const,
      TimeUnit: "MONTHLY" as const,
      BudgetLimit: { Amount: limit, Unit: "USD" },
      CalculatedSpend: {
        ActualSpend: { Amount: actual, Unit: "USD" },
        ForecastedSpend: { Amount: forecast, Unit: "USD" },
      },
    },
  };
}

function liveAction(overrides: Record<string, unknown> = {}) {
  return {
    Actions: [
      {
        ActionId: "action-1",
        BudgetName: BUDGET_NAME,
        Status: "STANDBY",
        Definition: {
          IamActionDefinition: {
            PolicyArn: FREEZE_POLICY_ARN,
            Roles: [BROKER_ROLE],
          },
        },
        ...overrides,
      },
    ],
  };
}

beforeEach(() => {
  budgetsMock.reset();
  iamMock.reset();
  // Default: the broker role exists and is not frozen.
  iamMock.on(ListAttachedRolePoliciesCommand).resolves({ AttachedPolicies: [] });
});

describe("region", () => {
  it("talks to us-east-1 whatever region the deployment lives in", async () => {
    // Budgets is global. A client built for the deployment's own region fails at
    // runtime and nowhere else, so this is not a style assertion.
    budgetsMock.on(DescribeBudgetCommand).rejects(notFound());
    await describeBedrockBudget(target);
    const client = budgetsMock.calls()[0].thisValue as BudgetsClient;
    expect(await client.config.region()).toBe("us-east-1");
  });
});

describe("ensureBedrockBudget", () => {
  it("creates budget then action on a fresh account", async () => {
    budgetsMock.on(DescribeBudgetCommand).rejects(notFound());
    budgetsMock.on(CreateBudgetCommand).resolves({});
    budgetsMock.on(CreateBudgetActionCommand).resolves({});

    const result = await ensureBedrockBudget({
      ...target,
      limitMicros: 25 * USD,
      notifyEmail: EMAIL,
    });

    expect(result).toEqual({
      createdBudget: true,
      updatedLimit: false,
      createdAction: true,
      updatedAction: false,
    });
    expect(budgetsMock.commandCalls(CreateBudgetCommand)[0].args[0].input).toEqual({
      AccountId: ACCOUNT,
      Budget: {
        BudgetName: BUDGET_NAME,
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: "25", Unit: "USD" },
        CostFilters: { Service: ["Amazon Bedrock"] },
      },
    });
    const action = budgetsMock.commandCalls(CreateBudgetActionCommand)[0].args[0].input;
    expect(action).toMatchObject({
      AccountId: ACCOUNT,
      BudgetName: BUDGET_NAME,
      ActionType: "APPLY_IAM_POLICY",
      ApprovalModel: "AUTOMATIC",
      NotificationType: "ACTUAL",
      ActionThreshold: { ActionThresholdValue: 100, ActionThresholdType: "PERCENTAGE" },
      Definition: {
        IamActionDefinition: { PolicyArn: FREEZE_POLICY_ARN, Roles: [BROKER_ROLE] },
      },
    });
  });

  it("makes no mutating call when the budget is already correct", async () => {
    budgetsMock.on(DescribeBudgetCommand).resolves(liveBudget("25"));
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves(liveAction());

    const result = await ensureBedrockBudget({
      ...target,
      limitMicros: 25 * USD,
      notifyEmail: EMAIL,
    });

    expect(result).toEqual({
      createdBudget: false,
      updatedLimit: false,
      createdAction: false,
      updatedAction: false,
    });
    // Asserted as a call count of zero, not as "no error" — an ensure that
    // silently re-creates on every install is a different bug with the same
    // green test.
    expect(budgetsMock.commandCalls(CreateBudgetCommand)).toHaveLength(0);
    expect(budgetsMock.commandCalls(UpdateBudgetCommand)).toHaveLength(0);
    expect(budgetsMock.commandCalls(CreateBudgetActionCommand)).toHaveLength(0);
    expect(budgetsMock.commandCalls(UpdateBudgetActionCommand)).toHaveLength(0);
  });

  it("updates the limit when it drifted, without re-creating the budget", async () => {
    budgetsMock.on(DescribeBudgetCommand).resolves(liveBudget("25"));
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves(liveAction());
    budgetsMock.on(UpdateBudgetCommand).resolves({});

    const result = await ensureBedrockBudget({
      ...target,
      limitMicros: 50 * USD,
      notifyEmail: EMAIL,
    });

    expect(result.updatedLimit).toBe(true);
    expect(result.createdBudget).toBe(false);
    expect(budgetsMock.commandCalls(CreateBudgetCommand)).toHaveLength(0);
    expect(
      budgetsMock.commandCalls(UpdateBudgetCommand)[0].args[0].input.NewBudget?.BudgetLimit,
    ).toEqual({ Amount: "50", Unit: "USD" });
  });

  it("repairs the half-built state: budget exists, no action", async () => {
    // What a run that failed between the two creates leaves behind.
    budgetsMock.on(DescribeBudgetCommand).resolves(liveBudget("25"));
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves({ Actions: [] });
    budgetsMock.on(CreateBudgetActionCommand).resolves({});

    const result = await ensureBedrockBudget({
      ...target,
      limitMicros: 25 * USD,
      notifyEmail: EMAIL,
    });

    expect(result).toMatchObject({ createdBudget: false, createdAction: true });
    expect(budgetsMock.commandCalls(CreateBudgetCommand)).toHaveLength(0);
  });

  it("reconciles a drifted Roles[] against bedrockFreezeTargetRoleNames", async () => {
    // The §4.3 mechanism: adding a future Bedrock-spending role is one line in
    // the constant plus a reinstall, and THIS is the reinstall half of it.
    budgetsMock.on(DescribeBudgetCommand).resolves(liveBudget("25"));
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves(
      liveAction({
        Definition: {
          IamActionDefinition: { PolicyArn: FREEZE_POLICY_ARN, Roles: ["starkeep-app-old-role"] },
        },
      }),
    );
    budgetsMock.on(UpdateBudgetActionCommand).resolves({});

    const result = await ensureBedrockBudget({
      ...target,
      limitMicros: 25 * USD,
      notifyEmail: EMAIL,
    });

    expect(result.updatedAction).toBe(true);
    const input = budgetsMock.commandCalls(UpdateBudgetActionCommand)[0].args[0].input;
    expect(input.ActionId).toBe("action-1");
    expect(input.Definition?.IamActionDefinition?.Roles).toEqual([BROKER_ROLE]);
  });
});

describe("describeBedrockBudget", () => {
  it("maps a live budget + action into the UI shape, in micros", async () => {
    budgetsMock.on(DescribeBudgetCommand).resolves(liveBudget("25", "3.5", "9.25"));
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves(liveAction());
    budgetsMock.on(DescribeBudgetActionHistoriesCommand).resolves({ ActionHistories: [] });

    const status = await describeBedrockBudget(target);

    expect(status).toEqual({
      exists: true,
      limitMicros: 25 * USD,
      actualSpendMicros: 3_500_000,
      forecastedSpendMicros: 9_250_000,
      actionId: "action-1",
      actionStatus: "STANDBY",
      frozenRoleNames: [],
      targetRoleNames: [BROKER_ROLE],
      lastExecuted: null,
    });
  });

  it.each([
    "STANDBY",
    "PENDING",
    "EXECUTION_IN_PROGRESS",
    "EXECUTION_SUCCESS",
    "EXECUTION_FAILURE",
    "REVERSE_IN_PROGRESS",
    "REVERSE_SUCCESS",
    "RESET_IN_PROGRESS",
    "RESET_FAILURE",
  ])("passes through the %s lifecycle value verbatim", async (status) => {
    budgetsMock.on(DescribeBudgetCommand).resolves(liveBudget("25"));
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves(liveAction({ Status: status }));
    budgetsMock.on(DescribeBudgetActionHistoriesCommand).resolves({ ActionHistories: [] });

    expect((await describeBedrockBudget(target)).actionStatus).toBe(status);
  });

  it("reports exists: false when there is no budget", async () => {
    budgetsMock.on(DescribeBudgetCommand).rejects(notFound());
    const status = await describeBedrockBudget(target);
    expect(status.exists).toBe(false);
    expect(status.limitMicros).toBeNull();
  });

  it("reads frozen-ness live from IAM, not from the action's status", async () => {
    // The §3 self-clear case: a budget action can read STANDBY (its policy was
    // auto-detached at the month boundary) while a cached "we froze it" flag
    // would still claim apps are broken — and, in the other direction, a MANUAL
    // freeze never moves the action's status at all.
    budgetsMock.on(DescribeBudgetCommand).resolves(liveBudget("25"));
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves(liveAction({ Status: "STANDBY" }));
    budgetsMock.on(DescribeBudgetActionHistoriesCommand).resolves({ ActionHistories: [] });
    iamMock
      .on(ListAttachedRolePoliciesCommand)
      .resolves({ AttachedPolicies: [{ PolicyArn: FREEZE_POLICY_ARN, PolicyName: "freeze" }] });

    const status = await describeBedrockBudget(target);
    expect(status.actionStatus).toBe("STANDBY");
    expect(status.frozenRoleNames).toEqual([BROKER_ROLE]);
  });

  it("reports the freeze even when the budget itself is gone", async () => {
    // An operator can disable the budget while a freeze is still applied; a UI
    // that then said "not frozen" would misexplain why every app is failing.
    budgetsMock.on(DescribeBudgetCommand).rejects(notFound());
    iamMock
      .on(ListAttachedRolePoliciesCommand)
      .resolves({ AttachedPolicies: [{ PolicyArn: FREEZE_POLICY_ARN, PolicyName: "freeze" }] });

    const status = await describeBedrockBudget(target);
    expect(status.exists).toBe(false);
    expect(status.frozenRoleNames).toEqual([BROKER_ROLE]);
  });

  it("reports the most recent execution timestamp", async () => {
    budgetsMock.on(DescribeBudgetCommand).resolves(liveBudget("25"));
    budgetsMock
      .on(DescribeBudgetActionsForBudgetCommand)
      .resolves(liveAction({ Status: "EXECUTION_SUCCESS" }));
    budgetsMock.on(DescribeBudgetActionHistoriesCommand).resolves({
      ActionHistories: [
        { Status: "EXECUTION_SUCCESS", Timestamp: new Date("2026-06-14T10:00:00Z") },
        { Status: "EXECUTION_SUCCESS", Timestamp: new Date("2026-07-14T10:00:00Z") },
        { Status: "STANDBY", Timestamp: new Date("2026-08-01T00:00:00Z") },
      ],
    });

    expect((await describeBedrockBudget(target)).lastExecuted).toBe("2026-07-14T10:00:00.000Z");
  });

  it("treats a missing broker role as simply not frozen", async () => {
    budgetsMock.on(DescribeBudgetCommand).rejects(notFound());
    iamMock.on(ListAttachedRolePoliciesCommand).rejects(noSuchEntity());
    expect((await describeBedrockBudget(target)).frozenRoleNames).toEqual([]);
  });
});

describe("deleteBedrockBudget", () => {
  it("deletes the action before the budget", async () => {
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves(liveAction());
    budgetsMock.on(DeleteBudgetActionCommand).resolves({});
    budgetsMock.on(DeleteBudgetCommand).resolves({});

    await deleteBedrockBudget(target);

    // AWS refuses to delete a budget that still has an action, so the ORDER is
    // the contract, not an implementation detail.
    const order = budgetsMock
      .calls()
      .map((c) => c.args[0].constructor.name)
      .filter((n) => n.startsWith("Delete"));
    expect(order).toEqual(["DeleteBudgetActionCommand", "DeleteBudgetCommand"]);
  });

  it("is a no-op, not a throw, when nothing exists", async () => {
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).rejects(notFound());
    budgetsMock.on(DeleteBudgetCommand).rejects(notFound());
    await expect(deleteBedrockBudget(target)).resolves.toBeUndefined();
  });

  it("is clean when called twice in a row", async () => {
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves(liveAction());
    budgetsMock.on(DeleteBudgetActionCommand).resolves({}).rejects(notFound());
    budgetsMock.on(DeleteBudgetCommand).resolves({}).rejects(notFound());
    await deleteBedrockBudget(target);
    await expect(deleteBedrockBudget(target)).resolves.toBeUndefined();
  });
});

describe("freezeBedrock", () => {
  it("attaches the freeze policy to every target role", async () => {
    iamMock.on(AttachRolePolicyCommand).resolves({});
    expect(await freezeBedrock(target)).toEqual([BROKER_ROLE]);
    expect(iamMock.commandCalls(AttachRolePolicyCommand)[0].args[0].input).toEqual({
      RoleName: BROKER_ROLE,
      PolicyArn: FREEZE_POLICY_ARN,
    });
  });
});

describe("resumeBedrock", () => {
  it("reverses the budget action when Budgets reports it executed", async () => {
    budgetsMock
      .on(DescribeBudgetActionsForBudgetCommand)
      .resolves(liveAction({ Status: "EXECUTION_SUCCESS" }));
    budgetsMock.on(ExecuteBudgetActionCommand).resolves({});

    const result = await resumeBedrock(target);

    expect(result.via).toBe("reverse");
    expect(budgetsMock.commandCalls(ExecuteBudgetActionCommand)[0].args[0].input).toMatchObject({
      ActionId: "action-1",
      ExecutionType: "REVERSE_BUDGET_ACTION",
    });
    expect(iamMock.commandCalls(DetachRolePolicyCommand)).toHaveLength(0);
  });

  it("detaches directly when the action never fired (a manual freeze)", async () => {
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves(liveAction({ Status: "STANDBY" }));
    iamMock.on(DetachRolePolicyCommand).resolves({});

    const result = await resumeBedrock(target);

    expect(result.via).toBe("detach");
    expect(result.roleNames).toEqual([BROKER_ROLE]);
    expect(budgetsMock.commandCalls(ExecuteBudgetActionCommand)).toHaveLength(0);
  });

  it("falls back to detach — and reports why — when the reverse fails", async () => {
    // "Resume did nothing and said nothing" is the worst outcome this control
    // has, so the fallback must actually fire AND the reason must survive.
    budgetsMock
      .on(DescribeBudgetActionsForBudgetCommand)
      .resolves(liveAction({ Status: "EXECUTION_SUCCESS" }));
    budgetsMock.on(ExecuteBudgetActionCommand).rejects(new Error("action already reversed"));
    iamMock.on(DetachRolePolicyCommand).resolves({});

    const result = await resumeBedrock(target);

    expect(result.via).toBe("detach");
    expect(result.reverseError).toContain("already reversed");
    expect(iamMock.commandCalls(DetachRolePolicyCommand)).toHaveLength(1);
  });

  it("detaches when there is no budget at all", async () => {
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).rejects(notFound());
    iamMock.on(DetachRolePolicyCommand).resolves({});
    expect((await resumeBedrock(target)).via).toBe("detach");
  });

  it("treats an already-detached policy as success", async () => {
    budgetsMock.on(DescribeBudgetActionsForBudgetCommand).resolves({ Actions: [] });
    iamMock.on(DetachRolePolicyCommand).rejects(noSuchEntity());
    await expect(resumeBedrock(target)).resolves.toMatchObject({ via: "detach" });
  });
});
