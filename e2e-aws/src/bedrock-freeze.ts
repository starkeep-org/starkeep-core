/**
 * Manager-scoped freeze/resume for the Tier-3 freeze drill (budget-guardrail
 * plan §8.2).
 *
 * The drill exercises the EFFECT of a spend freeze without breaching a real
 * budget: attach the freeze policy, call the broker, assert it is refused, then
 * detach and assert normal service resumes. That is possible only because
 * Manager holds the same condition-scoped `iam:AttachRolePolicy` the budget
 * action does — so the drill tests OUR policy, not AWS's budget evaluation
 * (which is AWS's function, costs real money to trigger, and takes a day to
 * return a verdict).
 *
 * Deliberately goes through Manager rather than the ambient operator identity:
 * a drill that attached the policy as an account admin would prove nothing about
 * whether the grant we actually ship is sufficient.
 */

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  freezeBedrock,
  resumeBedrock,
  describeBedrockBudget,
  type BedrockBudgetCredentials,
  type BedrockBudgetStatus,
} from "@starkeep/aws-bootstrap/bedrock-budget-ops";

export interface FreezeDrillTarget {
  stackPrefix: string;
  accountId: string;
  region: string;
  managerRoleArn: string;
  /** The admin session's Identity-Pool credentials — the only identity
   * permitted to assume Manager. */
  adminCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

async function managerCreds(target: FreezeDrillTarget): Promise<BedrockBudgetCredentials> {
  const sts = new STSClient({
    region: target.region,
    credentials: target.adminCredentials,
  });
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: target.managerRoleArn,
      RoleSessionName: "e2e-bedrock-freeze-drill",
    }),
  );
  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error("Manager assume returned no credentials");
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };
}

export async function drillFreeze(target: FreezeDrillTarget): Promise<string[]> {
  return freezeBedrock({
    stackPrefix: target.stackPrefix,
    accountId: target.accountId,
    credentials: await managerCreds(target),
  });
}

export async function drillResume(target: FreezeDrillTarget): Promise<void> {
  await resumeBedrock({
    stackPrefix: target.stackPrefix,
    accountId: target.accountId,
    credentials: await managerCreds(target),
  });
}

export async function drillStatus(target: FreezeDrillTarget): Promise<BedrockBudgetStatus> {
  return describeBedrockBudget({
    stackPrefix: target.stackPrefix,
    accountId: target.accountId,
    credentials: await managerCreds(target),
  });
}
