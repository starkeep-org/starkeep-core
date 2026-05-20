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
import type { AwsCredentials } from "./session";
import { buildPulumiProgram } from "./pulumi-program";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  S3Client,
  ListObjectsV2Command,
  GetBucketAccelerateConfigurationCommand,
} from "@aws-sdk/client-s3";
import * as os from "node:os";
import * as path from "node:path";

// Pulumi CLI is intentionally not a package/system dependency — see the cloud
// install docs. Instead, we install it on demand into a per-user cache the first
// time any cloud install runs, and reuse it on every subsequent invocation.
const PULUMI_CLI_ROOT = path.join(os.homedir(), ".starkeep", "pulumi");

let pulumiCommandPromise: Promise<pulumi.PulumiCommand> | undefined;

async function ensurePulumiCli(): Promise<pulumi.PulumiCommand> {
  if (!pulumiCommandPromise) {
    pulumiCommandPromise = (async () => {
      try {
        return await pulumi.PulumiCommand.get({ root: PULUMI_CLI_ROOT });
      } catch {
        console.log(`Installing Pulumi CLI into ${PULUMI_CLI_ROOT}…`);
        return pulumi.PulumiCommand.install({ root: PULUMI_CLI_ROOT });
      }
    })().catch((err) => {
      pulumiCommandPromise = undefined;
      throw err;
    });
  }
  return pulumiCommandPromise;
}

export interface ComputeContext {
  stackPrefix: string;
  appId: string;
  appRoleArn: string;
  apiGatewayId: string;
  authorizerId: string;
  region: string;
  accountId: string;
  pulumiStateBucket: string;
  dsqlHostname: string;
  filesBucket: string;
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

/**
 * Run `fn` with retry on AccessDenied. Used to absorb IAM PutRolePolicy
 * propagation delay after Manager attaches the temp-install policy: AWS
 * docs say propagation can take a couple of minutes worst case, and
 * individual (action, resource) pairs propagate independently — so each
 * fresh action needs its own probe before we hand control to Pulumi.
 *
 * Budget: 12 attempts, exp backoff capped at 10s → ~90s worst case.
 */
async function retryOnAccessDenied<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 12;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  let delay = 1000;
  const start = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[diag] ${label}: succeeded on attempt ${attempt} after ${elapsed}s`);
      }
      return result;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const message = (err as { message?: string })?.message ?? "";
      const isAccessDenied =
        name === "AccessDeniedException" ||
        name === "AccessDenied" ||
        message.includes("AccessDenied");
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (!isAccessDenied) {
        console.log(`[diag] ${label}: attempt ${attempt} non-retryable error after ${elapsed}s: ${name ?? "?"}`);
        throw err;
      }
      if (attempt === maxAttempts) {
        console.log(`[diag] ${label}: gave up after ${attempt} attempts / ${elapsed}s`);
        throw err;
      }
      console.log(
        `[diag] ${label}: attempt ${attempt} AccessDenied at ${elapsed}s, retrying in ${(delay / 1000).toFixed(1)}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
  throw new Error(`unreachable: ${label}`);
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

  return retryOnAccessDenied("ssm:GetParameter pulumi/passphrase", async () => {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: `/${ctx.stackPrefix}/pulumi/passphrase`,
        WithDecryption: true,
      }),
    );
    const value = result.Parameter?.Value;
    if (!value) throw new Error("Pulumi passphrase not found in SSM");
    return value;
  });
}

/**
 * Pre-flight check that the freshly-attached temp-install policy is in
 * effect for `s3:ListBucket` on the Pulumi state bucket before we hand
 * control to the Pulumi CLI.
 *
 * Why: Pulumi's very first action against the S3 state backend (e.g.
 * `pulumi stack select` reading `.pulumi/meta.yaml`) is a ListBucket.
 * That action's IAM propagation is independent of the SSM passphrase
 * we just fetched — so SSM succeeding does NOT mean S3 is ready. If
 * ListBucket isn't live yet, Pulumi surfaces the failure as an opaque
 * subprocess error from the CLI; running the same call here through
 * the SDK lets `retryOnAccessDenied` absorb the propagation window and
 * gives a clean, attributable error if it ultimately fails.
 *
 * We use `ListObjectsV2` (with MaxKeys=1, Prefix=".pulumi/") rather
 * than HeadBucket because HeadBucket requires `s3:ListBucket` too but
 * doesn't always surface AccessDenied the same way across SDK versions;
 * ListObjectsV2 is the same shape Pulumi itself issues.
 */
async function probePulumiStateBucket(opts: {
  pulumiStateBucket: string;
  region: string;
  appCreds: AwsCredentials;
}): Promise<void> {
  const s3 = new S3Client({
    region: opts.region,
    credentials: {
      accessKeyId: opts.appCreds.accessKeyId,
      secretAccessKey: opts.appCreds.secretAccessKey,
      sessionToken: opts.appCreds.sessionToken,
    },
  });

  // S3's authz cache propagation after PutRolePolicy is observed to take
  // multiple minutes in some accounts/regions — much longer than other
  // services (e.g. SSM resolves in 15–35s while S3 on the same policy
  // attach is still denying at 85s+). Budget ~5 minutes here so we can
  // wait through the slow case without aborting.
  await retryOnAccessDenied(
    `s3:ListBucket ${opts.pulumiStateBucket}`,
    async () => {
      await s3.send(
        new ListObjectsV2Command({
          Bucket: opts.pulumiStateBucket,
          Prefix: ".pulumi/",
          MaxKeys: 1,
        }),
      );
    },
    { maxAttempts: 30, maxDelayMs: 10_000 },
  );

  // Also probe s3:GetAccelerateConfiguration. PutRolePolicy propagation is
  // per-action: ListBucket passing does NOT guarantee GetAccelerateConfiguration
  // is ready. Pulumi's BucketV2 provider reads accelerate config immediately
  // after creating every bucket; if the permission hasn't propagated yet the
  // create fails. Probing on the known-existing state bucket (which has this
  // action in TempInstallPulumiState) is a valid proxy — the policy propagates
  // as a unit so this bucket's success confirms the files/billing bucket
  // permissions are also live.
  await retryOnAccessDenied(
    `s3:GetAccelerateConfiguration ${opts.pulumiStateBucket}`,
    async () => {
      await s3.send(
        new GetBucketAccelerateConfigurationCommand({
          Bucket: opts.pulumiStateBucket,
        }),
      );
    },
    { maxAttempts: 30, maxDelayMs: 10_000 },
  );
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
  program: () => Promise<Record<string, unknown> | void>;
  pulumiStateBucket: string;
  region: string;
  stackPrefix: string;
  appCreds: AwsCredentials;
  /** Called after stack selection but before refresh/up, with the set of URNs currently in state. */
  preCleanupOrphans?: (inStateUrns: Set<string>) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const [passphrase, pulumiCommand] = await Promise.all([
    getPulumiPassphrase({
      stackPrefix: opts.stackPrefix,
      region: opts.region,
      appCreds: opts.appCreds,
    }),
    ensurePulumiCli(),
    probePulumiStateBucket({
      pulumiStateBucket: opts.pulumiStateBucket,
      region: opts.region,
      appCreds: opts.appCreds,
    }),
  ]);

  const stack = await pulumi.LocalWorkspace.createOrSelectStack(
    {
      stackName: opts.stackName,
      projectName: opts.projectName,
      program: opts.program,
    },
    {
      pulumiCommand,
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

  // Pre-cleanup: detect AWS resources that exist but aren't in Pulumi state
  // (left over from previously interrupted runs) and remove them so the
  // subsequent `up` can create them cleanly instead of failing on AlreadyExists.
  if (opts.preCleanupOrphans) {
    const deployment = await stack.exportStack();
    const resources = (
      (deployment.deployment as { resources?: Array<{ urn: string }> } | undefined)?.resources ?? []
    );
    const inStateUrns = new Set(resources.map((r) => r.urn));
    await opts.preCleanupOrphans(inStateUrns);
  }

  // Clear any pending operations left by a prior interrupted run before
  // attempting up. refresh is a no-op on a brand-new stack.
  try {
    await stack.refresh({ onOutput: console.log });
  } catch {
    // Ignore refresh errors (e.g. stack has no state yet).
  }

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
  const [passphrase, pulumiCommand] = await Promise.all([
    getPulumiPassphrase({
      stackPrefix: opts.stackPrefix,
      region: opts.region,
      appCreds: opts.appCreds,
    }),
    ensurePulumiCli(),
    probePulumiStateBucket({
      pulumiStateBucket: opts.pulumiStateBucket,
      region: opts.region,
      appCreds: opts.appCreds,
    }),
  ]);

  let stack: pulumi.Stack;
  try {
    stack = await pulumi.LocalWorkspace.selectStack(
      {
        stackName: opts.stackName,
        projectName: opts.projectName,
        program: async () => {},
      },
      {
        pulumiCommand,
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
