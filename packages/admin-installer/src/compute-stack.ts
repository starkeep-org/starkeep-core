/**
 * Pulumi Automation API wrapper for per-app compute resources.
 *
 * On install: creates Lambda(s), log groups, API Gateway integration(s) + routes
 * attached to the SST-owned HTTP API, using the app's STS-assumed credentials.
 *
 * On uninstall: runs stack.destroy() + workspace.removeStack() — one declarative
 * call cleans up all Pulumi-managed resources for this app.
 */

import * as pulumi from "@pulumi/pulumi/automation/index.js";
import type { AppManifest } from "@starkeep/admin-manifest";
import type { AwsCredentials } from "./session.js";
import { buildPulumiProgram } from "./pulumi-program.js";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

export interface ComputeContext {
  stackPrefix: string;
  appId: string;
  appRoleArn: string;
  apiGatewayId: string;
  authorizerId: string;
  region: string;
  accountId: string;
  pulumiStateBucket: string;
  appCreds: AwsCredentials;
}

export interface InstallReceipt {
  functionArns: string[];
  routeIds: string[];
}

async function getPulumiPassphrase(ctx: ComputeContext): Promise<string> {
  const ssm = new SSMClient({
    region: ctx.region,
    credentials: {
      accessKeyId: ctx.appCreds.accessKeyId,
      secretAccessKey: ctx.appCreds.secretAccessKey,
      sessionToken: ctx.appCreds.sessionToken,
    },
  });
  const result = await ssm.send(
    new GetParameterCommand({
      Name: `/${ctx.stackPrefix}/pulumi/passphrase`,
      WithDecryption: true,
    }),
  );
  const value = result.Parameter?.Value;
  if (!value) throw new Error("Pulumi passphrase not found in SSM");
  return value;
}

export async function installComputeStack(
  manifest: AppManifest,
  ctx: ComputeContext,
): Promise<InstallReceipt> {
  const passphrase = await getPulumiPassphrase(ctx);

  const stackName = `${ctx.stackPrefix}-app-${ctx.appId}`;
  const s3StateUrl = `s3://${ctx.pulumiStateBucket}`;

  const stack = await pulumi.LocalWorkspace.createOrSelectStack(
    {
      stackName,
      projectName: `${ctx.stackPrefix}-apps`,
      program: buildPulumiProgram(manifest, ctx),
    },
    {
      workDir: undefined,
      envVars: {
        AWS_ACCESS_KEY_ID: ctx.appCreds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: ctx.appCreds.secretAccessKey,
        AWS_SESSION_TOKEN: ctx.appCreds.sessionToken,
        AWS_REGION: ctx.region,
        PULUMI_CONFIG_PASSPHRASE: passphrase,
        PULUMI_BACKEND_URL: s3StateUrl,
      },
    },
  );

  await stack.setConfig("aws:region", { value: ctx.region });

  const result = await stack.up({ onOutput: console.log });

  const functionArns: string[] = [];
  const routeIds: string[] = [];
  for (const [key, output] of Object.entries(result.outputs)) {
    const val = (output as { value: unknown }).value;
    if (key.startsWith("functionArn:")) functionArns.push(val as string);
    if (key.startsWith("routeId:")) routeIds.push(val as string);
  }

  return { functionArns, routeIds };
}

export async function uninstallComputeStack(ctx: ComputeContext): Promise<void> {
  const passphrase = await getPulumiPassphrase(ctx);

  const stackName = `${ctx.stackPrefix}-app-${ctx.appId}`;
  const s3StateUrl = `s3://${ctx.pulumiStateBucket}`;

  let stack: pulumi.Stack;
  try {
    stack = await pulumi.LocalWorkspace.selectStack(
      { stackName, projectName: `${ctx.stackPrefix}-apps`, program: async () => {} },
      {
        workDir: undefined,
        envVars: {
          AWS_ACCESS_KEY_ID: ctx.appCreds.accessKeyId,
          AWS_SECRET_ACCESS_KEY: ctx.appCreds.secretAccessKey,
          AWS_SESSION_TOKEN: ctx.appCreds.sessionToken,
          AWS_REGION: ctx.region,
          PULUMI_CONFIG_PASSPHRASE: passphrase,
          PULUMI_BACKEND_URL: s3StateUrl,
        },
      },
    );
  } catch {
    // Stack may not exist if compute was never enabled
    return;
  }

  await stack.destroy({ onOutput: console.log });
  await stack.workspace.removeStack(stackName);
}
