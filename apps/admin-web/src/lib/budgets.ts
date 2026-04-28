import {
  BudgetsClient,
  DescribeBudgetCommand,
  CreateBudgetCommand,
  DeleteBudgetCommand,
  type Budget,
  type Notification,
  type Subscriber,
  NotificationType,
  ComparisonOperator,
  SubscriptionType,
  ThresholdType,
} from "@aws-sdk/client-budgets";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { STSCredentials } from "./cognito-auth";

export interface BudgetStatus {
  limitUsd: number;
  actualSpend: number;
  forecastedSpend: number | null;
  /** ok < 80%, warning 80–99%, breached ≥ 100% */
  state: "ok" | "warning" | "breached";
}

function makeBudgetsClient(creds: STSCredentials, region: string): BudgetsClient {
  return new BudgetsClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

function budgetName(stackPrefix: string): string {
  return `starkeep-${stackPrefix}-monthly`;
}

export async function getAccountId(creds: STSCredentials, region: string): Promise<string> {
  const client = new STSClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
  const response = await client.send(new GetCallerIdentityCommand({}));
  if (!response.Account) throw new Error("Could not determine AWS account ID");
  return response.Account;
}

export async function getBudgetStatus(
  creds: STSCredentials,
  region: string,
  accountId: string,
  stackPrefix: string,
): Promise<BudgetStatus | null> {
  const client = makeBudgetsClient(creds, region);
  let budget: Budget;
  try {
    const response = await client.send(
      new DescribeBudgetCommand({ AccountId: accountId, BudgetName: budgetName(stackPrefix) }),
    );
    if (!response.Budget) return null;
    budget = response.Budget;
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === "NotFoundException") return null;
    throw err;
  }

  const limitUsd = parseFloat(budget.BudgetLimit?.Amount ?? "0");
  const actualSpend = parseFloat(budget.CalculatedSpend?.ActualSpend?.Amount ?? "0");
  const forecastedRaw = budget.CalculatedSpend?.ForecastedSpend?.Amount;
  const forecastedSpend = forecastedRaw != null ? parseFloat(forecastedRaw) : null;

  const pct = limitUsd > 0 ? actualSpend / limitUsd : 0;
  const state: BudgetStatus["state"] =
    pct >= 1 ? "breached" : pct >= 0.8 ? "warning" : "ok";

  return { limitUsd, actualSpend, forecastedSpend, state };
}

export async function setBudgetLimit(
  creds: STSCredentials,
  region: string,
  accountId: string,
  stackPrefix: string,
  limitUsd: number,
  userEmail: string,
): Promise<void> {
  const client = makeBudgetsClient(creds, region);
  const name = budgetName(stackPrefix);

  // Delete then recreate to avoid partial-update complexity.
  await removeBudget(creds, region, accountId, stackPrefix);

  const emailSubscriber: Subscriber = {
    SubscriptionType: SubscriptionType.EMAIL,
    Address: userEmail,
  };
  const warningNotification: Notification = {
    NotificationType: NotificationType.ACTUAL,
    ComparisonOperator: ComparisonOperator.GREATER_THAN,
    Threshold: 80,
    ThresholdType: ThresholdType.PERCENTAGE,
  };
  const breachNotification: Notification = {
    NotificationType: NotificationType.ACTUAL,
    ComparisonOperator: ComparisonOperator.GREATER_THAN,
    Threshold: 100,
    ThresholdType: ThresholdType.PERCENTAGE,
  };

  await client.send(
    new CreateBudgetCommand({
      AccountId: accountId,
      Budget: {
        BudgetName: name,
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: limitUsd.toFixed(2), Unit: "USD" },
      },
      NotificationsWithSubscribers: [
        { Notification: warningNotification, Subscribers: [emailSubscriber] },
        { Notification: breachNotification, Subscribers: [emailSubscriber] },
      ],
    }),
  );
}

export async function removeBudget(
  creds: STSCredentials,
  region: string,
  accountId: string,
  stackPrefix: string,
): Promise<void> {
  const client = makeBudgetsClient(creds, region);
  try {
    await client.send(
      new DeleteBudgetCommand({ AccountId: accountId, BudgetName: budgetName(stackPrefix) }),
    );
  } catch (err) {
    const e = err as { name?: string };
    if (e.name !== "NotFoundException") throw err;
  }
}
