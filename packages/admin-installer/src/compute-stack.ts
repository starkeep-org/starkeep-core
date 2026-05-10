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

/**
 * Minimal context for fetching the Pulumi passphrase from SSM. ComputeContext
 * is a superset; built-in installs that don't need the per-app fields can pass
 * just this.
 */
export interface PulumiCredsContext {
  stackPrefix: string;
  region: string;
  appCreds: AwsCredentials;
}

async function getPulumiPassphrase(ctx: PulumiCredsContext): Promise<string> {
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

/**
 * Run pulumi up against an arbitrary inline program. Generalized so both the
 * per-app installer (which generates its program from a manifest) and the
 * built-in cloud-data-server installer (which uses a hardcoded program) can
 * share the same Automation API plumbing.
 *
 * Returns the raw outputs map from `stack.up()`. Callers are responsible for
 * extracting and typing the outputs they expect.
 */
export async function pulumiUpInline(opts: {
  stackName: string;
  projectName: string;
  program: () => Promise<void>;
  pulumiStateBucket: string;
  region: string;
  stackPrefix: string;
  appCreds: AwsCredentials;
}): Promise<Record<string, unknown>> {
  const passphrase = await getPulumiPassphrase({
    stackPrefix: opts.stackPrefix,
    region: opts.region,
    appCreds: opts.appCreds,
  });

  const stack = await pulumi.LocalWorkspace.createOrSelectStack(
    {
      stackName: opts.stackName,
      projectName: opts.projectName,
      program: opts.program,
    },
    {
      workDir: undefined,
      envVars: {
        AWS_ACCESS_KEY_ID: opts.appCreds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: opts.appCreds.secretAccessKey,
        AWS_SESSION_TOKEN: opts.appCreds.sessionToken,
        AWS_REGION: opts.region,
        PULUMI_CONFIG_PASSPHRASE: passphrase,
        PULUMI_BACKEND_URL: `s3://${opts.pulumiStateBucket}`,
      },
    },
  );

  await stack.setConfig("aws:region", { value: opts.region });
  const result = await stack.up({ onOutput: console.log });

  const outputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.outputs)) {
    outputs[key] = (value as { value: unknown }).value;
  }
  return outputs;
}

/** Symmetric uninstall — removes the named stack and its workspace. */
export async function pulumiDestroyInline(opts: {
  stackName: string;
  projectName: string;
  pulumiStateBucket: string;
  region: string;
  stackPrefix: string;
  appCreds: AwsCredentials;
}): Promise<void> {
  const passphrase = await getPulumiPassphrase({
    stackPrefix: opts.stackPrefix,
    region: opts.region,
    appCreds: opts.appCreds,
  });

  let stack: pulumi.Stack;
  try {
    stack = await pulumi.LocalWorkspace.selectStack(
      {
        stackName: opts.stackName,
        projectName: opts.projectName,
        program: async () => {},
      },
      {
        workDir: undefined,
        envVars: {
          AWS_ACCESS_KEY_ID: opts.appCreds.accessKeyId,
          AWS_SECRET_ACCESS_KEY: opts.appCreds.secretAccessKey,
          AWS_SESSION_TOKEN: opts.appCreds.sessionToken,
          AWS_REGION: opts.region,
          PULUMI_CONFIG_PASSPHRASE: passphrase,
          PULUMI_BACKEND_URL: `s3://${opts.pulumiStateBucket}`,
        },
      },
    );
  } catch {
    // Stack doesn't exist — already torn down (or never created).
    return;
  }

  await stack.destroy({ onOutput: console.log });
  await stack.workspace.removeStack(opts.stackName);
}

export async function installComputeStack(
  manifest: AppManifest,
  ctx: ComputeContext,
): Promise<InstallReceipt> {
  const outputs = await pulumiUpInline({
    stackName: `${ctx.stackPrefix}-app-${ctx.appId}`,
    projectName: `${ctx.stackPrefix}-apps`,
    program: buildPulumiProgram(manifest, ctx),
    pulumiStateBucket: ctx.pulumiStateBucket,
    region: ctx.region,
    stackPrefix: ctx.stackPrefix,
    appCreds: ctx.appCreds,
  });

  const functionArns: string[] = [];
  const routeIds: string[] = [];
  for (const [key, val] of Object.entries(outputs)) {
    if (key.startsWith("functionArn:")) functionArns.push(val as string);
    if (key.startsWith("routeId:")) routeIds.push(val as string);
  }

  return { functionArns, routeIds };
}

export async function uninstallComputeStack(ctx: ComputeContext): Promise<void> {
  await pulumiDestroyInline({
    stackName: `${ctx.stackPrefix}-app-${ctx.appId}`,
    projectName: `${ctx.stackPrefix}-apps`,
    pulumiStateBucket: ctx.pulumiStateBucket,
    region: ctx.region,
    stackPrefix: ctx.stackPrefix,
    appCreds: ctx.appCreds,
  });
}
