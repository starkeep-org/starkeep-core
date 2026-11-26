/**
 * `starkeep cloud cost`: the month's cost by service from the deployment's
 * cost and usage report, as admin-web's Costs section shows it.
 *
 * The report bills the whole AWS account, not only the deployment, and AWS
 * delivers it about once a day.
 */
import {
  fetchMtdCostsByService,
  projectFullMonth,
  type ServiceCost,
} from "@starkeep/operator/costs";
import { readConfig } from "@starkeep/operator/config";
import { adminCredentialsOrSignIn } from "../cloud";
import { stringFlag, type Command } from "../command";
import { CliError, usageError } from "../errors";

/** The first day of the month `YYYY-MM` names, in local time. */
export function monthOf(text: string): Date {
  const match = /^(\d{4})-(\d{2})$/.exec(text);
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) {
    throw usageError("--month takes a month as YYYY-MM, such as 2026-11.");
  }
  return new Date(Number(match[1]), month - 1, 1);
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The table's lines: each service from the largest cost down, then the total. */
export function costLines(costs: ServiceCost[], projection: ServiceCost[] | null): string[] {
  const sorted = [...costs].sort((a, b) => b.amount - a.amount);
  const width = Math.max(7, ...sorted.map((c) => c.service.length)) + 2;
  const line = (label: string, amount: string, projected: string) =>
    `${label.padEnd(width)}${amount.padStart(13)}${projection ? projected.padStart(12) : ""}`;
  const projectedOf = (service: string) =>
    projection?.find((p) => p.service === service)?.amount ?? 0;
  const total = sorted.reduce((sum, c) => sum + c.amount, 0);
  const projectedTotal = (projection ?? []).reduce((sum, c) => sum + c.amount, 0);
  return [
    line("SERVICE", "MONTH-TO-DATE", "PROJECTED"),
    ...sorted.map((c) => line(c.service, dollars(c.amount), dollars(projectedOf(c.service)))),
    line("Total", dollars(total), dollars(projectedTotal)),
  ];
}

export const cloudCostCommand: Command = {
  name: "cloud cost",
  summary: "Show the month's cost by service from the AWS cost report",
  usage: "[--month YYYY-MM]",
  lane: "admin",
  flags: {
    month: {
      type: "string",
      description: "A past month, such as 2026-10 (default: this month).",
    },
  },
  details:
    "Reads the cost and usage report the deploy set up. The report bills the whole AWS\n" +
    "account, so it includes services outside Starkeep. AWS delivers it about once a day.\n" +
    "This month's costs come with a month-end projection.",
  async run(io, args) {
    const monthFlag = stringFlag(args, "month");
    const now = new Date();
    const month = monthFlag ? monthOf(monthFlag) : now;
    const current =
      month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth();
    const stackPrefix = readConfig()?.stackPrefix;
    if (typeof stackPrefix !== "string") {
      throw new CliError("This computer has no cloud. Run `starkeep setup --cloud` first.");
    }
    const admin = await adminCredentialsOrSignIn(io);
    let costs: ServiceCost[] | null;
    try {
      costs = await fetchMtdCostsByService(admin.stsCredentials, stackPrefix, admin.region, month);
    } catch (err) {
      const code =
        (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
      if (code !== "NoSuchBucket") throw err;
      costs = null;
    }
    const projection = costs && current ? projectFullMonth(costs, now) : null;
    if (io.json) {
      io.event({ type: "result", ok: true, data: { costs, projection } });
      return;
    }
    io.print("Includes both Starkeep and non-Starkeep service costs.");
    io.print();
    if (costs === null) {
      // Only this month's report is still on its way; a past month's never comes.
      io.print(
        current
          ? "Cost report configured — data arrives within 24 hours."
          : `No cost report covers ${monthFlag}.`,
      );
      return;
    }
    for (const text of costLines(costs, projection)) io.print(text);
  },
};
