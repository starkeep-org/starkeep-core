import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GroupDefinitionType,
} from "@aws-sdk/client-cost-explorer";
import type { STSCredentials } from "./cognito-auth";

export interface ServiceCost {
  service: string;
  amount: number;
}

const SERVICE_LABELS: Record<string, string> = {
  "AWS Lambda": "Lambda",
  "Amazon Simple Storage Service": "S3",
  "Amazon Aurora DSQL": "Aurora DSQL",
};

const KNOWN_SERVICES = new Set(Object.keys(SERVICE_LABELS));

function makeClient(creds: STSCredentials): CostExplorerClient {
  // Cost Explorer is a global service — endpoint is always us-east-1.
  return new CostExplorerClient({
    region: "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

function currentMonthDateRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  // End must be exclusive and at most today
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

export async function fetchMtdCostsByService(
  creds: STSCredentials,
): Promise<ServiceCost[]> {
  const client = makeClient(creds);
  const { start, end } = currentMonthDateRange();

  const response = await client.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION" as GroupDefinitionType, Key: "SERVICE" }],
    }),
  );

  const rawByService: Record<string, number> = {};
  for (const result of response.ResultsByTime ?? []) {
    for (const group of result.Groups ?? []) {
      const serviceName = group.Keys?.[0] ?? "Other";
      const amount = parseFloat(group.Metrics?.["UnblendedCost"]?.Amount ?? "0");
      rawByService[serviceName] = (rawByService[serviceName] ?? 0) + amount;
    }
  }

  const buckets: Record<string, number> = {
    Lambda: 0,
    S3: 0,
    "Aurora DSQL": 0,
    Other: 0,
  };

  for (const [name, amount] of Object.entries(rawByService)) {
    if (KNOWN_SERVICES.has(name)) {
      const label = SERVICE_LABELS[name]!;
      buckets[label] = (buckets[label] ?? 0) + amount;
    } else {
      buckets["Other"] = (buckets["Other"] ?? 0) + amount;
    }
  }

  return Object.entries(buckets).map(([service, amount]) => ({ service, amount }));
}

export function projectFullMonth(costs: ServiceCost[], today = new Date()): ServiceCost[] {
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  // Days elapsed = day-of-month (1-based), minimum 1 to avoid division by zero.
  const daysElapsed = Math.max(today.getDate(), 1);
  const factor = daysInMonth / daysElapsed;
  return costs.map(({ service, amount }) => ({
    service,
    amount: amount * factor,
  }));
}
