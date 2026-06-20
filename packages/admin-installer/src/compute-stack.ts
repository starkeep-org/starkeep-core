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
import { retryOnAccessDenied } from "./retry-on-access-denied";
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

// Flip to true to forward pulumi's stderr (gRPC + AWS provider HTTP traces
// emitted under PULUMI_OPTION_LOGTOSTDERR + PULUMI_OPTION_VERBOSE) to our
// own stderr so the admin-web install log-tee can capture it. Pairs with
// the matching PULUMI_VERBOSE_TRACE flag in the install route handlers.
const PULUMI_VERBOSE_TRACE = false;

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
  /**
   * Per-app role ARN. The Pulumi program passes this as the Lambda exec
   * role; the role itself is created and tagged by Manager before this
   * context is built.
   */
  appRoleArn: string;
  apiGatewayId: string;
  /**
   * Execution ARN of the shared API Gateway, used as the source-arn on
   * aws.lambda.Permission so API Gateway is allowed to invoke per-app
   * Lambdas (replaces the IAM-implicit invoke path which no longer covers
   * this case under the stripped per-app boundary).
   */
  apiGatewayExecutionArn: string;
  /**
   * Public base URL of the shared API Gateway (the cloud-data-server's stage
   * URL). Injected into per-app Lambdas as STARKEEP_CLOUD_DATA_BASE so they
   * can call the broker over HTTPS via @starkeep/app-client.
   */
  apiGatewayUrl: string;
  authorizerId: string;
  region: string;
  accountId: string;
  pulumiStateBucket: string;
  /** Bucket holding apps/<appId>/latest/dist.zip — Lambda code source. */
  artifactsBucket: string;
  dsqlHostname: string;
  filesBucket: string;
  /**
   * Base64-encoded SHA-256 of the uploaded dist.zip. Wired to
   * aws.lambda.Function.sourceCodeHash so Pulumi sees the bundle change
   * even though s3Key is constant (apps/<appId>/latest/dist.zip).
   * Optional: not all callers (e.g. uninstall) need to provide it.
   */
  bundleHash?: string;
  /**
   * install-infra credentials. Per-app Pulumi up/destroy runs as
   * install-infra (not the per-app role); this carries the install-time
   * AWS-provisioning power scoped to this app via a temp policy attached
   * upstream in the orchestrator.
   */
  infraCreds: AwsCredentials;
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
  awsCreds: AwsCredentials;
}

// retryOnAccessDenied lives in ./retry-on-access-denied.ts so dsql-ddl can
// share it for the dsql:DbConnectAdmin propagation probe.

async function getPulumiPassphrase(ctx: PulumiCredsContext): Promise<string> {
  const ssm = new SSMClient({
    region: ctx.region,
    credentials: {
      accessKeyId: ctx.awsCreds.accessKeyId,
      secretAccessKey: ctx.awsCreds.secretAccessKey,
      sessionToken: ctx.awsCreds.sessionToken,
    },
  });

  // Same budget as probePulumiStateBucket below (30 / ~300s, vs the default
  // 24 / ~215s): the passphrase read and the S3 probe run together in the
  // same Promise.all gating one Pulumi up/destroy, so a shorter budget here
  // makes SSM the premature long-pole — a slow temp-policy propagation can
  // make this give up at ~215s while the S3 probe (30 attempts) is still
  // waiting and about to succeed, rejecting the whole operation. (Observed on
  // an app uninstall: SSM still AccessDenied at 186s+, gave up at ~205s.)
  return retryOnAccessDenied(
    "ssm:GetParameter pulumi/passphrase",
    async () => {
      const result = await ssm.send(
        new GetParameterCommand({
          Name: `/${ctx.stackPrefix}/pulumi/passphrase`,
          WithDecryption: true,
        }),
      );
      const value = result.Parameter?.Value;
      if (!value) throw new Error("Pulumi passphrase not found in SSM");
      return value;
    },
    { maxAttempts: 30, maxDelayMs: 10_000 },
  );
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
  awsCreds: AwsCredentials;
}): Promise<void> {
  const s3 = new S3Client({
    region: opts.region,
    credentials: {
      accessKeyId: opts.awsCreds.accessKeyId,
      secretAccessKey: opts.awsCreds.secretAccessKey,
      sessionToken: opts.awsCreds.sessionToken,
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
  awsCreds: AwsCredentials;
  /** Called after stack selection but before refresh/up, with the set of URNs currently in state. */
  preCleanupOrphans?: (inStateUrns: Set<string>) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const [passphrase, pulumiCommand] = await Promise.all([
    getPulumiPassphrase({
      stackPrefix: opts.stackPrefix,
      region: opts.region,
      awsCreds: opts.awsCreds,
    }),
    ensurePulumiCli(),
    probePulumiStateBucket({
      pulumiStateBucket: opts.pulumiStateBucket,
      region: opts.region,
      awsCreds: opts.awsCreds,
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
        AWS_ACCESS_KEY_ID: opts.awsCreds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: opts.awsCreds.secretAccessKey,
        AWS_SESSION_TOKEN: opts.awsCreds.sessionToken,
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

  // iam-permission-tests POC: forward pulumi's stderr to our own stderr so
  // PULUMI_OPTION_LOGTOSTDERR=true + -v=9 traces (which include the AWS
  // provider's HTTP requests/responses) reach the install log-tee in
  // admin-web. Without onError, automation API buffers stderr internally
  // and only surfaces it on failure. Gated by PULUMI_VERBOSE_TRACE so it
  // can be flipped back on when we need the traces again.
  const onError = PULUMI_VERBOSE_TRACE
    ? (line: string) => process.stderr.write(line)
    : undefined;

  // Clear any pending operations left by a prior interrupted run before
  // attempting up. refresh is a no-op on a brand-new stack.
  try {
    await stack.refresh({ onOutput: console.log, onError });
  } catch {
    // Ignore refresh errors (e.g. stack has no state yet).
  }

  const result = await stack.up({ onOutput: console.log, onError });

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
  awsCreds: AwsCredentials;
}): Promise<void> {
  const [passphrase, pulumiCommand] = await Promise.all([
    getPulumiPassphrase({
      stackPrefix: opts.stackPrefix,
      region: opts.region,
      awsCreds: opts.awsCreds,
    }),
    ensurePulumiCli(),
    probePulumiStateBucket({
      pulumiStateBucket: opts.pulumiStateBucket,
      region: opts.region,
      awsCreds: opts.awsCreds,
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
          AWS_ACCESS_KEY_ID: opts.awsCreds.accessKeyId,
          AWS_SECRET_ACCESS_KEY: opts.awsCreds.secretAccessKey,
          AWS_SESSION_TOKEN: opts.awsCreds.sessionToken,
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
    awsCreds: ctx.infraCreds,
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
    awsCreds: ctx.infraCreds,
  });
}
