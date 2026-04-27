/**
 * Thin wrapper around @aws-sdk/client-cloudformation for managing the
 * Starkeep deploy-permissions stack ({stackPrefix}-deploy-permissions).
 *
 * The bootstrap stack creates two IAM roles with only the bare minimum
 * inline policy needed to manage this stack. Everything else — DSQL,
 * Lambda, API Gateway, ECR, etc. — is granted by the managed policy that
 * lives in this stack and is attached to both roles. Updating permissions
 * = updating this stack. No bootstrap teardown required.
 */

import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  DescribeStackEventsCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  type StackEvent,
} from "@aws-sdk/client-cloudformation";
import type { STSCredentials } from "./cognito-auth";

export type PermissionsStackPhase =
  | "NOT_FOUND"
  | "CREATE_IN_PROGRESS"
  | "CREATE_COMPLETE"
  | "CREATE_FAILED"
  | "UPDATE_IN_PROGRESS"
  | "UPDATE_COMPLETE"
  | "UPDATE_FAILED"
  | "UPDATE_ROLLBACK_IN_PROGRESS"
  | "UPDATE_ROLLBACK_COMPLETE"
  | "UPDATE_ROLLBACK_FAILED"
  | "DELETE_IN_PROGRESS"
  | "DELETE_COMPLETE"
  | "DELETE_FAILED"
  | "ROLLBACK_IN_PROGRESS"
  | "ROLLBACK_COMPLETE"
  | "ROLLBACK_FAILED";

export interface PermissionsStackStatus {
  phase: PermissionsStackPhase;
  reason?: string;
}

const TERMINAL_PHASES = new Set<PermissionsStackPhase>([
  "NOT_FOUND",
  "CREATE_COMPLETE",
  "CREATE_FAILED",
  "UPDATE_COMPLETE",
  "UPDATE_FAILED",
  "UPDATE_ROLLBACK_COMPLETE",
  "UPDATE_ROLLBACK_FAILED",
  "DELETE_COMPLETE",
  "DELETE_FAILED",
  "ROLLBACK_COMPLETE",
  "ROLLBACK_FAILED",
]);

const SUCCESS_PHASES = new Set<PermissionsStackPhase>([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "DELETE_COMPLETE",
]);

function makeClient(creds: STSCredentials, region: string): CloudFormationClient {
  return new CloudFormationClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

export async function getPermissionsStackStatus(
  creds: STSCredentials,
  region: string,
  stackName: string,
): Promise<PermissionsStackStatus> {
  const client = makeClient(creds, region);
  try {
    const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = response.Stacks?.[0];
    if (!stack) return { phase: "NOT_FOUND" };
    return {
      phase: (stack.StackStatus ?? "CREATE_FAILED") as PermissionsStackPhase,
      reason: stack.StackStatusReason,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.name === "ValidationError" && e.message?.includes("does not exist")) {
      return { phase: "NOT_FOUND" };
    }
    throw err;
  }
}

export async function getCurrentTemplate(
  creds: STSCredentials,
  region: string,
  stackName: string,
): Promise<string | null> {
  const client = makeClient(creds, region);
  try {
    const response = await client.send(
      new GetTemplateCommand({ StackName: stackName, TemplateStage: "Original" }),
    );
    return response.TemplateBody ?? null;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.name === "ValidationError" && e.message?.includes("does not exist")) {
      return null;
    }
    throw err;
  }
}

export async function createPermissionsStack(
  creds: STSCredentials,
  region: string,
  stackName: string,
  templateBody: string,
): Promise<void> {
  const client = makeClient(creds, region);
  await client.send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateBody: templateBody,
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Tags: [{ Key: "starkeep:managed", Value: "true" }],
    }),
  );
}

export async function updatePermissionsStack(
  creds: STSCredentials,
  region: string,
  stackName: string,
  templateBody: string,
): Promise<{ noChanges: boolean }> {
  const client = makeClient(creds, region);
  try {
    await client.send(
      new UpdateStackCommand({
        StackName: stackName,
        TemplateBody: templateBody,
        Capabilities: ["CAPABILITY_NAMED_IAM"],
      }),
    );
    return { noChanges: false };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e.message?.includes("No updates are to be performed")) {
      return { noChanges: true };
    }
    throw err;
  }
}

export async function deletePermissionsStack(
  creds: STSCredentials,
  region: string,
  stackName: string,
): Promise<void> {
  const client = makeClient(creds, region);
  await client.send(new DeleteStackCommand({ StackName: stackName }));
}

export async function getRecentStackEvents(
  creds: STSCredentials,
  region: string,
  stackName: string,
  limit = 10,
): Promise<StackEvent[]> {
  const client = makeClient(creds, region);
  try {
    const response = await client.send(
      new DescribeStackEventsCommand({ StackName: stackName }),
    );
    return (response.StackEvents ?? []).slice(0, limit);
  } catch {
    return [];
  }
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (status: PermissionsStackStatus) => void;
}

export async function pollUntilTerminal(
  creds: STSCredentials,
  region: string,
  stackName: string,
  options: PollOptions = {},
): Promise<PermissionsStackStatus> {
  const intervalMs = options.intervalMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await getPermissionsStackStatus(creds, region, stackName);
    options.onUpdate?.(status);
    if (TERMINAL_PHASES.has(status.phase)) return status;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `Timed out waiting for stack ${stackName} after ${Math.round(timeoutMs / 1000)}s`,
  );
}

export function isSuccess(status: PermissionsStackStatus): boolean {
  return SUCCESS_PHASES.has(status.phase);
}

export function isTerminal(status: PermissionsStackStatus): boolean {
  return TERMINAL_PHASES.has(status.phase);
}

/**
 * Compare a freshly-generated template against the deployed stack template,
 * with whitespace normalized so cosmetic differences don't trigger updates.
 */
export function templatesAreEquivalent(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .join("\n");
  return normalize(a) === normalize(b);
}
