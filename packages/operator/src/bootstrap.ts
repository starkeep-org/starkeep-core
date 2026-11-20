/**
 * The AWS account owner lane: the bootstrap stack and nothing else.
 *
 * This is the only module that reads the terminal's own AWS credentials (a
 * profile, SSO or environment variables), through the SDK's default chain.
 * The bootstrap stack creates the admin's role and the user pool that signs
 * the admin in, so it cannot run as the admin. Everything else runs in the
 * admin lane, with credentials minted from the admin's Cognito sign-in
 * (`admin-session.ts`), and a test holds every other module to that.
 *
 * Before any write here, the CLI shows the account, the caller and the region,
 * refuses an account that differs from `config.json`'s `accountId`, warns on
 * the root user, and asks.
 */
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  waitUntilStackCreateComplete,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { generateBootstrapTemplate, inlineTemplateBody } from "@starkeep/aws-bootstrap";

export interface CallerIdentity {
  account: string;
  arn: string;
  /** The account's root user, which should not run day-to-day operations. */
  isRoot: boolean;
}

export interface OwnerClients {
  sts?: Pick<STSClient, "send">;
  cloudFormation?: Pick<CloudFormationClient, "send">;
  /** Waits for a stack create to finish. Tests pass one that returns at once. */
  waitForCreate?: (stackName: string) => Promise<void>;
}

/** Who the terminal's AWS credentials are, or a message that says how to sign in. */
export async function callerIdentity(
  region: string,
  clients: OwnerClients = {},
): Promise<CallerIdentity> {
  const sts = clients.sts ?? new STSClient({ region });
  let res;
  try {
    res = await sts.send(new GetCallerIdentityCommand({}));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `This terminal has no working AWS credentials (${reason}). ` +
        "Sign in to the AWS account with `aws configure sso` or `aws sso login`, or set AWS_PROFILE, then run the command again.",
    );
  }
  if (!res.Account || !res.Arn)
    throw new Error("AWS did not say which account these credentials belong to.");
  return { account: res.Account, arn: res.Arn, isRoot: res.Arn.endsWith(":root") };
}

export function bootstrapStackName(stackPrefix: string): string {
  return `${stackPrefix}-bootstrap`;
}

/** The bootstrap stack, or null when none exists with this prefix. */
export async function describeBootstrapStack(
  stackPrefix: string,
  region: string,
  clients: OwnerClients = {},
): Promise<Stack | null> {
  const cf = clients.cloudFormation ?? new CloudFormationClient({ region });
  try {
    const res = await cf.send(
      new DescribeStacksCommand({ StackName: bootstrapStackName(stackPrefix) }),
    );
    return res.Stacks?.[0] ?? null;
  } catch (err) {
    // DescribeStacks signals "no such stack" as a ValidationError.
    if ((err as { name?: string }).name === "ValidationError") return null;
    throw err;
  }
}

/** A stack state that holds the outputs setup needs. */
export function isUsableStack(stack: Stack): boolean {
  return ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(
    stack.StackStatus ?? "",
  );
}

/**
 * The bootstrap outputs `config.json` records, under the names the wizard and
 * the installer use.
 */
export interface BootstrapConfigOutputs {
  userPoolId: string;
  userPoolClientId: string;
  deviceUserPoolClientId: string;
  cognitoDomain: string;
  identityPoolId: string;
  managerRoleArn?: string;
  permissionsBoundaryArn?: string;
  foundationalPermissionsBoundaryArn?: string;
  userDataOwnerPermissionsBoundaryArn?: string;
  installDdlRoleArn?: string;
  installInfraRoleArn?: string;
  pulumiStateBucket?: string;
}

const REQUIRED_OUTPUTS: Record<string, keyof BootstrapConfigOutputs> = {
  UserPoolId: "userPoolId",
  UserPoolClientId: "userPoolClientId",
  DeviceUserPoolClientId: "deviceUserPoolClientId",
  CognitoDomain: "cognitoDomain",
  IdentityPoolId: "identityPoolId",
};

const OPTIONAL_OUTPUTS: Record<string, keyof BootstrapConfigOutputs> = {
  ManagerRoleArn: "managerRoleArn",
  AppPermissionsBoundaryArn: "permissionsBoundaryArn",
  AppFoundationalPermissionsBoundaryArn: "foundationalPermissionsBoundaryArn",
  UserDataOwnerPermissionsBoundaryArn: "userDataOwnerPermissionsBoundaryArn",
  InstallDdlRoleArn: "installDdlRoleArn",
  InstallInfraRoleArn: "installInfraRoleArn",
  PulumiStateBucketName: "pulumiStateBucket",
};

export function bootstrapOutputs(stack: Stack): BootstrapConfigOutputs {
  const byKey = new Map((stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue] as const));
  const out: Partial<BootstrapConfigOutputs> = {};
  const missing: string[] = [];
  for (const [key, field] of Object.entries(REQUIRED_OUTPUTS)) {
    const value = byKey.get(key);
    if (value) out[field] = value;
    else missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `The bootstrap stack ${stack.StackName} has no ${missing.join(", ")} output. ` +
        "Update it with scripts/update-bootstrap.sh --apply, then run setup again.",
    );
  }
  for (const [key, field] of Object.entries(OPTIONAL_OUTPUTS)) {
    const value = byKey.get(key);
    if (value) out[field] = value;
  }
  return out as BootstrapConfigOutputs;
}

export interface CreateBootstrapInput {
  stackPrefix: string;
  region: string;
  deploymentName: string;
  /** The first admin. Cognito emails this address a temporary password. */
  adminEmail: string;
}

/**
 * Create the bootstrap stack and wait for it. The template goes inline,
 * without its comments, which count toward CloudFormation's inline cap.
 */
export async function createBootstrapStack(
  input: CreateBootstrapInput,
  clients: OwnerClients = {},
): Promise<Stack> {
  const cf = clients.cloudFormation ?? new CloudFormationClient({ region: input.region });
  const stackName = bootstrapStackName(input.stackPrefix);
  const template = inlineTemplateBody(
    generateBootstrapTemplate({
      stackPrefix: input.stackPrefix,
      deploymentName: input.deploymentName,
      adminEmail: input.adminEmail,
    }),
  );
  await cf.send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateBody: template,
      Parameters: [
        { ParameterKey: "StackPrefix", ParameterValue: input.stackPrefix },
        { ParameterKey: "AdminEmail", ParameterValue: input.adminEmail },
      ],
      Capabilities: ["CAPABILITY_NAMED_IAM"],
      Tags: [{ Key: "starkeep:managed", Value: "true" }],
    }),
  );
  if (clients.waitForCreate) await clients.waitForCreate(stackName);
  else
    await waitUntilStackCreateComplete(
      { client: cf as CloudFormationClient, maxWaitTime: 20 * 60 },
      { StackName: stackName },
    );
  const created = await describeBootstrapStack(input.stackPrefix, input.region, {
    cloudFormation: cf,
  });
  if (!created) throw new Error(`The stack ${stackName} vanished after it was created.`);
  return created;
}
