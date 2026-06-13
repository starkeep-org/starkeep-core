/**
 * Create-if-missing for the bootstrap CloudFormation stack.
 *
 * Production setup hands the operator a console quick-create URL; the runner
 * deploys the same generated template programmatically so a Tier-3 run is
 * self-contained from a bare account. When the stack already exists its
 * outputs are read and verified instead — both halves of plan §11's
 * "bootstrap stack create (or verify)" leg.
 */

import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  waitUntilStackCreateComplete,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { generateBootstrapTemplate } from "@starkeep/aws-bootstrap";

export interface BootstrapOutputs {
  userPoolId: string;
  userPoolClientId: string;
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
  const byKey = new Map(
    (stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue] as const),
  );
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

export async function ensureBootstrapStack(options: {
  stackPrefix: string;
  region: string;
}): Promise<EnsureBootstrapStackResult> {
  const { stackPrefix, region } = options;
  const stackName = `${stackPrefix}-bootstrap`;
  const client = new CloudFormationClient({ region });

  const existing = await describeStack(client, stackName);
  if (existing) {
    if (existing.StackStatus !== "CREATE_COMPLETE" && existing.StackStatus !== "UPDATE_COMPLETE") {
      throw new Error(
        `bootstrap stack ${stackName} exists but is in state ${existing.StackStatus}; ` +
          `tear it down (scripts/teardown-bootstrap.sh --prefix ${stackPrefix}) and re-run`,
      );
    }
    return { outputs: outputsFromStack(existing, stackName), created: false };
  }

  await client.send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateBody: generateBootstrapTemplate({ stackPrefix }),
      Parameters: [{ ParameterKey: "StackPrefix", ParameterValue: stackPrefix }],
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      // No automatic rollback-delete: a failed create should stay visible
      // for diagnosis; teardown-bootstrap.sh handles partial-delete states.
      Tags: [{ Key: "starkeep:managed", Value: "true" }],
    }),
  );

  await waitUntilStackCreateComplete(
    { client, maxWaitTime: 15 * 60 },
    { StackName: stackName },
  );

  const created = await describeStack(client, stackName);
  if (!created) throw new Error(`stack ${stackName} vanished after create`);
  return { outputs: outputsFromStack(created, stackName), created: true };
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
