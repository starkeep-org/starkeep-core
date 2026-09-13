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
import { buildPulumiProgram, plannedRouteResourceNames } from "./pulumi-program";
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

/** One resource as it appears in an exported Pulumi deployment. */
export interface StateResource {
  urn: string;
  /** Provider-side id — the API Gateway route id, the function name, etc. */
  id?: string;
  /** Pulumi type token, e.g. `aws:apigatewayv2/route:Route`. */
  type?: string;
}

export interface ComputeContext {
  stackPrefix: string;
  appId: string;
  /**
   * Per-app **data** role ARN. Created and tagged by Manager before this
   * context is built. It holds the app's S3 and DSQL grants and is what the
   * broker assumes into on the app's behalf.
   *
   * This is deliberately not what the app's Lambdas run as — see
   * {@link appExecRoleArn}. It used to be, which made the manifest
   * non-binding on the app that wrote it.
   */
  appRoleArn: string;
  /**
   * Per-app **execution** role ARN — what the app's Lambdas actually run as.
   * Logs, its own HMAC credential, its own sibling functions, and nothing
   * else: no S3, no DSQL, no `sts:AssumeRole`.
   */
  appExecRoleArn: string;
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
  /**
   * The platform session authorizer (a REQUEST authorizer reading the session
   * cookie), for handlers declaring `auth: "session"`.
   *
   * Optional because a cloud-data-server stack installed before this existed
   * does not export one. The Pulumi program refuses rather than falling back
   * to no authorizer: a silent fallback would deploy the app wide open and
   * look like a successful install.
   */
  sessionAuthorizerId?: string;
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

  // Same budget as probePulumiStateBucket below (45 / ~415s): the passphrase
  // read and the S3 probe run together in the same Promise.all gating one
  // Pulumi up/destroy, so a shorter budget here makes SSM the premature
  // long-pole — a slow temp-policy propagation can make this give up while the
  // S3 probe is still waiting and about to succeed, rejecting the whole
  // operation. Per-service propagation is independent and either side can be
  // the long-pole: SSM has been observed still AccessDenied at 186s+ in one
  // run, and again at 256s in an uninstall where S3 (same policy attach) had
  // already gone live at 246s and the old 30-attempt (~266s) budget gave up at
  // 266s. 45 attempts (~415s) covers the worst observed case for either side
  // with margin.
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
    { maxAttempts: 45, maxDelayMs: 10_000 },
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
  // multiple minutes in some accounts/regions. Which service is the long-pole
  // is not fixed — S3 has been seen still denying at 85s+ while SSM resolved in
  // 15–35s, and the reverse (SSM still denying at 256s while S3 went live at
  // 246s) on an uninstall. Budget ~415s (45 attempts) here so we wait through
  // the slow case for either side without aborting.
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
    { maxAttempts: 45, maxDelayMs: 10_000 },
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
    { maxAttempts: 45, maxDelayMs: 10_000 },
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
  /**
   * Picks resources to delete before `up` runs, given everything currently in
   * state. Pulumi creates before it deletes, so a resource whose Pulumi name
   * changed while its cloud-side identity did not — an API Gateway route
   * keyed on a path, say — would have its replacement created while the old
   * one still holds that identity, and the provider rejects the create. Any
   * URN returned here is destroyed first, which frees the identity and drops
   * the resource from state in one step.
   */
  pruneBeforeUp?: (resources: StateResource[]) => string[];
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

  // Both pre-`up` hooks read the same state snapshot, so export it once.
  let stateResources: StateResource[] = [];
  if (opts.preCleanupOrphans || opts.pruneBeforeUp) {
    const deployment = await stack.exportStack();
    stateResources =
      (deployment.deployment as { resources?: StateResource[] } | undefined)?.resources ?? [];
  }

  // Pre-cleanup: detect AWS resources that exist but aren't in Pulumi state
  // (left over from previously interrupted runs) and remove them so the
  // subsequent `up` can create them cleanly instead of failing on AlreadyExists.
  if (opts.preCleanupOrphans) {
    await opts.preCleanupOrphans(new Set(stateResources.map((r) => r.urn)));
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

  // Prune before refresh: a pruned resource is gone from both AWS and state
  // by the time `up` plans its creates, so the create sees a free identity.
  const pruneUrns = opts.pruneBeforeUp?.(stateResources) ?? [];
  if (pruneUrns.length > 0) {
    console.log(`Pruning ${pruneUrns.length} superseded resource(s) before update…`);
    await stack.destroy({ target: pruneUrns, onOutput: console.log, onError });
  }

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

/**
 * URNs of route resources this stack still owns under a name the program no
 * longer registers — a route whose path left the manifest, and every route
 * carried over from the position-based naming this installer used before
 * {@link routeResourceName}.
 *
 * Leaving one in place breaks the install outright. Pulumi would see the old
 * resource and the new one as unrelated, create the new route first, and API
 * Gateway would answer `ConflictException: Route with key ANY /apps/<app>/…
 * already exists` because the old route still holds the key.
 */
function staleRouteUrns(manifest: AppManifest, resources: StateResource[]): string[] {
  const planned = plannedRouteResourceNames(manifest);
  return resources
    .filter((r) => r.type === "aws:apigatewayv2/route:Route")
    .filter((r) => !planned.has(r.urn.split("::").pop() ?? ""))
    .map((r) => r.urn);
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
    pruneBeforeUp: (resources) => staleRouteUrns(manifest, resources),
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
