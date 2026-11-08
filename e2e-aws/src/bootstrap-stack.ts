/**
 * Create-if-missing for the bootstrap CloudFormation stack.
 *
 * Production setup hands the operator a console quick-create URL; the runner
 * deploys the same generated template programmatically so a Tier-3 run is
 * self-contained from a bare account. When the stack already exists its
 * outputs are read and verified instead — both halves of plan §11's
 * "bootstrap stack create (or verify)" leg.
 */

import { dirname } from "node:path";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackUpdateComplete,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { generateBootstrapTemplate } from "@starkeep/aws-bootstrap";
import type { TestStackConfig } from "./run-state.js";

export interface BootstrapOutputs {
  userPoolId: string;
  userPoolClientId: string;
  deviceUserPoolClientId: string;
  cognitoDomain: string;
  identityPoolId: string;
  adminAppRoleArn: string;
  managerRoleArn: string;
  appPermissionsBoundaryArn: string;
  appFoundationalPermissionsBoundaryArn: string;
  userDataOwnerPermissionsBoundaryArn: string;
  installDdlRoleArn: string;
  installInfraRoleArn: string;
  pulumiStateBucketName: string;
  artifactsBucketName: string;
}

const REQUIRED_OUTPUT_KEYS: Record<keyof BootstrapOutputs, string> = {
  userPoolId: "UserPoolId",
  userPoolClientId: "UserPoolClientId",
  deviceUserPoolClientId: "DeviceUserPoolClientId",
  cognitoDomain: "CognitoDomain",
  identityPoolId: "IdentityPoolId",
  adminAppRoleArn: "AdminAppRoleArn",
  managerRoleArn: "ManagerRoleArn",
  appPermissionsBoundaryArn: "AppPermissionsBoundaryArn",
  appFoundationalPermissionsBoundaryArn: "AppFoundationalPermissionsBoundaryArn",
  userDataOwnerPermissionsBoundaryArn: "UserDataOwnerPermissionsBoundaryArn",
  installDdlRoleArn: "InstallDdlRoleArn",
  installInfraRoleArn: "InstallInfraRoleArn",
  pulumiStateBucketName: "PulumiStateBucketName",
  artifactsBucketName: "ArtifactsBucketName",
};

function outputsFromStack(stack: Stack, stackName: string): BootstrapOutputs {
  const byKey = new Map((stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue] as const));
  const result: Partial<Record<keyof BootstrapOutputs, string>> = {};
  for (const [field, key] of Object.entries(REQUIRED_OUTPUT_KEYS)) {
    const value = byKey.get(key);
    if (!value) {
      throw new Error(`bootstrap stack ${stackName} is missing output ${key}`);
    }
    result[field as keyof BootstrapOutputs] = value;
  }
  return result as BootstrapOutputs;
}

export interface EnsureBootstrapStackResult {
  outputs: BootstrapOutputs;
  created: boolean;
}

/** The suite's deployment name, in the invitation email and under the sign-in star. */
export const E2E_DEPLOYMENT_NAME = "Starkeep e2e";

export async function ensureBootstrapStack(options: {
  stackPrefix: string;
  region: string;
}): Promise<EnsureBootstrapStackResult> {
  const { stackPrefix, region } = options;
  const stackName = `${stackPrefix}-bootstrap`;
  const client = new CloudFormationClient({ region });

  const template = generateBootstrapTemplate({
    stackPrefix,
    deploymentName: E2E_DEPLOYMENT_NAME,
  });

  const existing = await describeStack(client, stackName);
  if (existing) {
    if (existing.StackStatus !== "CREATE_COMPLETE" && existing.StackStatus !== "UPDATE_COMPLETE") {
      throw new Error(
        `bootstrap stack ${stackName} exists but is in state ${existing.StackStatus}; ` +
          `tear it down (scripts/teardown-bootstrap.sh --prefix ${stackPrefix}) and re-run`,
      );
    }
    // Reusing the stack as-is would mean testing yesterday's permissions
    // boundaries against today's installer. That is not a theoretical concern:
    // the boundaries are exactly where an install-blocking permission gap
    // lives, and a run that reuses a stale one reports green on a policy the
    // code no longer matches. So bring it up to date first.
    await updateIfDrifted(client, stackName, stackPrefix, template);
    const refreshed = await describeStack(client, stackName);
    if (!refreshed) throw new Error(`stack ${stackName} vanished during update`);
    return { outputs: outputsFromStack(refreshed, stackName), created: false };
  }

  await client.send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateBody: template,
      Parameters: [{ ParameterKey: "StackPrefix", ParameterValue: stackPrefix }],
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      // No automatic rollback-delete: a failed create should stay visible
      // for diagnosis; teardown-bootstrap.sh handles partial-delete states.
      Tags: [{ Key: "starkeep:managed", Value: "true" }],
    }),
  );

  await waitUntilStackCreateComplete({ client, maxWaitTime: 15 * 60 }, { StackName: stackName });

  const created = await describeStack(client, stackName);
  if (!created) throw new Error(`stack ${stackName} vanished after create`);
  return { outputs: outputsFromStack(created, stackName), created: true };
}

/**
 * Push the generated template at an existing stack when it differs from what's
 * deployed. `GetTemplate` returns the body as submitted, so a string compare is
 * exact — and when nothing changed, CloudFormation's own "No updates are to be
 * performed" is the cheapest possible no-op.
 */
async function updateIfDrifted(
  client: CloudFormationClient,
  stackName: string,
  stackPrefix: string,
  template: string,
): Promise<void> {
  const deployed = await client.send(new GetTemplateCommand({ StackName: stackName }));
  if (deployed.TemplateBody === template) return;

  console.log(`bootstrap stack ${stackName} is out of date; updating…`);
  try {
    await client.send(
      new UpdateStackCommand({
        StackName: stackName,
        TemplateBody: template,
        Parameters: [{ ParameterKey: "StackPrefix", ParameterValue: stackPrefix }],
        Capabilities: ["CAPABILITY_NAMED_IAM"],
      }),
    );
  } catch (err) {
    // The template text differs but resolves to the same resources (formatting,
    // comments). Nothing to wait for.
    if (/No updates are to be performed/i.test((err as Error).message)) return;
    throw err;
  }
  await waitUntilStackUpdateComplete({ client, maxWaitTime: 15 * 60 }, { StackName: stackName });
}

async function describeStack(
  client: CloudFormationClient,
  stackName: string,
): Promise<Stack | undefined> {
  try {
    const res = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    return res.Stacks?.[0];
  } catch (err) {
    // DescribeStacks signals "no such stack" as a ValidationError.
    if ((err as { name?: string }).name === "ValidationError") return undefined;
    throw err;
  }
}

/**
 * The CLI-facing config for a run, from the bootstrap stack's outputs, keeping
 * any cloud-data-server outputs a previous kept-up run wrote.
 *
 * `appDir` is the app the run installs. The config names its PARENT, not the
 * app: `resolveAppDir` scans each entry's children for a manifest whose id
 * matches, so naming the app's own directory would have it look inside the app
 * for a nested copy of itself and find nothing. Derived rather than configured:
 * the parent of an app's directory is a directory that contains that app, by
 * construction, so there is nothing here for a caller to get wrong.
 */
export function stackConfigFrom(
  previous: TestStackConfig | undefined,
  stackPrefix: string,
  outputs: BootstrapOutputs,
  appDir: string,
): TestStackConfig {
  return {
    ...previous,
    stackPrefix,
    userPoolId: outputs.userPoolId,
    userPoolClientId: outputs.userPoolClientId,
    deviceUserPoolClientId: outputs.deviceUserPoolClientId,
    cognitoDomain: outputs.cognitoDomain,
    deploymentName: E2E_DEPLOYMENT_NAME,
    identityPoolId: outputs.identityPoolId,
    managerRoleArn: outputs.managerRoleArn,
    permissionsBoundaryArn: outputs.appPermissionsBoundaryArn,
    foundationalPermissionsBoundaryArn: outputs.appFoundationalPermissionsBoundaryArn,
    userDataOwnerPermissionsBoundaryArn: outputs.userDataOwnerPermissionsBoundaryArn,
    pulumiStateBucket: outputs.pulumiStateBucketName,
    appParentDirs: [dirname(appDir)],
  };
}
