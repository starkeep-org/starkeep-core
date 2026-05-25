/**
 * Built-in app install/update entry points.
 *
 * Currently scoped to cloud-data-server. The flow mirrors the per-app installer
 * (Manager → temp-policy → Pulumi up → schema init → detach), but with two
 * structural differences:
 *
 *   1. Idempotency uses existence checks (does the role exist? is the temp
 *      policy attached?) rather than the shared.app_install_steps cloud
 *      ledger — because that table is created by the very schema init this
 *      install runs. Pulumi's own state handles compute-step idempotency.
 *
 *   2. The Pulumi program is hardcoded (buildCloudDataServerProgram) rather
 *      than generated from the manifest. cloud-data-server provisions
 *      foundational resources (DSQL cluster, files bucket, API Gateway with
 *      Cognito JWT authorizer) that the per-app program shape can't express.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, DeleteBucketCommand } from "@aws-sdk/client-s3";
import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  CostAndUsageReportServiceClient,
  DeleteReportDefinitionCommand,
} from "@aws-sdk/client-cost-and-usage-report-service";
import {
  LambdaClient,
  DeleteFunctionCommand,
} from "@aws-sdk/client-lambda";
import { roleChain, type AwsCredentials } from "./session";
import {
  appRoleExists,
  attachTempInstallCloudDataServerPolicy,
  createAppRole,
  deleteAppRoleWithPolicies,
  detachTempInstallCloudDataServerPolicy,
  updateAppRoleTrustPolicy,
} from "./iam";
import { pulumiUpInline, pulumiDestroyInline } from "./compute-stack";
import { initializeSharedSchema } from "./dsql-schema-init";
import { buildCloudDataServerProgram } from "./builtin-programs/cloud-data-server-program";
import {
  logAppRoleSnapshot,
  logCallerIdentity,
} from "./iam-diagnostics";
import { LOCAL_DATA_SYNC_APP_ID, assertCloudInstallableAppId } from "./iam";
import { installApp, uninstallApp, type InstallerConfig } from "./orchestrator";
import { appManifestSchema } from "@starkeep/admin-manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the cloud-data-server built-in package directory. */
function cloudDataServerPackageDir(): string {
  // src/ → ../builtin-apps/cloud-data-server/
  return resolve(__dirname, "..", "builtin-apps", "cloud-data-server");
}

interface CloudDataServerManifest {
  id: "cloud-data-server";
  name: string;
  version: string;
  tier: string;
  infraRequirements: {
    brokerPower: boolean;
    sharedTypeAccess: unknown[];
  };
}

function loadCloudDataServerManifest(): CloudDataServerManifest {
  const path = join(cloudDataServerPackageDir(), "manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as CloudDataServerManifest;
}

export interface CloudDataServerInstallConfig {
  stackPrefix: string;
  region: string;
  accountId: string;
  permissionsBoundaryArn: string;
  foundationalPermissionsBoundaryArn: string;
  managerRoleArn: string;
  pulumiStateBucket: string;
  /** Cognito user-pool resources from the bootstrap CFN stack. */
  userPoolId: string;
  userPoolClientId: string;
}

export interface CloudDataServerInstallOutputs {
  appRoleArn: string;
  auroraHostname: string;
  bucketName: string;
  apiGatewayUrl: string;
  apiGatewayId: string;
  apiGatewayExecutionArn: string;
  authorizerId: string;
  functionArn: string;
  region: string;
}

/**
 * Returns a pre-cleanup callback for `pulumiUpInline` that deletes known
 * orphaned AWS resources (left by previously interrupted installs) before
 * the next `pulumi up` attempt. Only acts on resources whose URNs are
 * absent from the current Pulumi stack state — managed resources are never
 * touched.
 *
 * Deletion is best-effort; any error is swallowed so Pulumi can surface its
 * own diagnostics on the subsequent `up`.
 */
function makeCloudDataServerOrphanCleaner(
  config: CloudDataServerInstallConfig,
  appCreds: AwsCredentials,
): (inStateUrns: Set<string>) => Promise<void> {
  return async (inStateUrns) => {
    const stackName = `${config.stackPrefix}-cloud-data-server`;
    const projectName = `${config.stackPrefix}-builtins`;
    const credentials = {
      accessKeyId: appCreds.accessKeyId,
      secretAccessKey: appCreds.secretAccessKey,
      sessionToken: appCreds.sessionToken,
    };

    const s3 = new S3Client({ region: config.region, credentials });
    const logs = new CloudWatchLogsClient({ region: config.region, credentials });
    const lambda = new LambdaClient({ region: config.region, credentials });
    // CUR is a global service that only accepts requests to us-east-1.
    const cur = new CostAndUsageReportServiceClient({ region: "us-east-1", credentials });

    const candidates = [
      {
        urn: `urn:pulumi:${stackName}::${projectName}::aws:s3/bucketV2:BucketV2::${config.stackPrefix}-files`,
        label: `files bucket ${config.stackPrefix}-files-${config.accountId}-${config.region}`,
        cleanup: () =>
          s3.send(
            new DeleteBucketCommand({
              Bucket: `${config.stackPrefix}-files-${config.accountId}-${config.region}`,
            }),
          ),
      },
      {
        urn: `urn:pulumi:${stackName}::${projectName}::aws:s3/bucketV2:BucketV2::${config.stackPrefix}-billing`,
        label: `billing bucket ${config.stackPrefix}-billing-${config.accountId}-${config.region}`,
        cleanup: () =>
          s3.send(
            new DeleteBucketCommand({
              Bucket: `${config.stackPrefix}-billing-${config.accountId}-${config.region}`,
            }),
          ),
      },
      {
        urn: `urn:pulumi:${stackName}::${projectName}::aws:cloudwatch/logGroup:LogGroup::api-log-group`,
        label: `log group /aws/lambda/${config.stackPrefix}-app-cloud-data-server-api`,
        cleanup: () =>
          logs.send(
            new DeleteLogGroupCommand({
              logGroupName: `/aws/lambda/${config.stackPrefix}-app-cloud-data-server-api`,
            }),
          ),
      },
      {
        urn: `urn:pulumi:${stackName}::${projectName}::aws:lambda/function:Function::api`,
        label: `lambda function ${config.stackPrefix}-app-cloud-data-server-api`,
        cleanup: () =>
          lambda.send(
            new DeleteFunctionCommand({
              FunctionName: `${config.stackPrefix}-app-cloud-data-server-api`,
            }),
          ),
      },
      {
        urn: `urn:pulumi:${stackName}::${projectName}::aws:cur/reportDefinition:ReportDefinition::${config.stackPrefix}-billing`,
        label: `CUR report ${config.stackPrefix}-billing`,
        cleanup: () =>
          cur.send(
            new DeleteReportDefinitionCommand({
              ReportName: `${config.stackPrefix}-billing`,
            }),
          ),
      },
    ];

    for (const { urn, label, cleanup } of candidates) {
      if (inStateUrns.has(urn)) continue;
      try {
        await cleanup();
        console.log(`[pre-flight] Cleared orphaned ${label}`);
      } catch (err) {
        const code = (err as { name?: string })?.name;
        if (code !== "NoSuchBucket" && code !== "ResourceNotFoundException") {
          console.log(`[pre-flight] ${label}: ${code ?? String(err)} — leaving for Pulumi`);
        }
      }
    }
  };
}

/**
 * Install (or update) the cloud-data-server built-in app.
 *
 * Idempotent — safe to re-run. Each AWS-side check is an existence check,
 * each compute step is Pulumi (which natively no-ops on unchanged state),
 * and the shared-schema DDL is fully idempotent (CREATE ... IF NOT EXISTS).
 *
 * On a fresh AWS account the steps are: mint role → attach temp policy →
 * pulumi up (creates DSQL/S3/Lambda/APIGw) → initialize shared schema
 * (creates shared.records et al) → detach temp policy. On re-run: role
 * exists (skip), temp policy reattaches (idempotent PutRolePolicy), pulumi
 * up no-ops, schema init re-applies idempotent DDL, detach succeeds.
 */
export async function installCloudDataServer(
  config: CloudDataServerInstallConfig,
): Promise<CloudDataServerInstallOutputs> {
  const manifest = loadCloudDataServerManifest();
  const appId = "cloud-data-server";
  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;

  assertCloudInstallableAppId(appId);

  const managerCreds = await roleChain([config.managerRoleArn]);

  // Step 1: Ensure the cloud-data-server role exists.
  if (!(await appRoleExists(config.stackPrefix, appId, managerCreds))) {
    console.log(`Creating ${config.stackPrefix}-app-${appId}-role…`);
    await createAppRole({
      stackPrefix: config.stackPrefix,
      appId,
      accountId: config.accountId,
      permissionsBoundaryArn: config.permissionsBoundaryArn,
      foundationalPermissionsBoundaryArn: config.foundationalPermissionsBoundaryArn,
      sharedTypeAccess: [],
      canIngestUnknown: false,
      canPromoteFromUnknown: false,
      brokerPower: manifest.infraRequirements.brokerPower,
      managerCreds,
    });
  } else {
    console.log(`${config.stackPrefix}-app-${appId}-role already exists; skipping create.`);
    // Heal trust-policy drift in case the manager role was deleted +
    // recreated (its RoleId would have changed, leaving any existing app
    // role's trust policy pointing at the dead AROA). Idempotent.
    console.log("Refreshing app role trust policy…");
    await updateAppRoleTrustPolicy(config.stackPrefix, appId, config.accountId, managerCreds);
  }

  // Step 2: Attach the wider temp-install-cloud-data-server policy.
  // Returns true when PutRolePolicy was actually called (policy is new or changed).
  // Skips the IAM call — and the propagation delay — when the policy is already
  // identical to what's live (common on retries after a failed run).
  console.log("Attaching temp-install-cloud-data-server policy…");
  const policyUpdated = await attachTempInstallCloudDataServerPolicy(
    config.stackPrefix,
    config.accountId,
    config.region,
    managerCreds,
  );

  if (policyUpdated) {
    // Give Lambda, CUR, and other services time to pick up the new policy.
    // S3 propagation is handled separately by probePulumiStateBucket (which
    // can take much longer and probes explicitly). 60 s covers Lambda/CUR
    // in the vast majority of cases.
    const LAMBDA_CUR_PROPAGATION_WAIT_MS = 60_000;
    console.log(
      `Policy changed — waiting ${LAMBDA_CUR_PROPAGATION_WAIT_MS / 1000}s for ` +
        "IAM propagation to Lambda and CUR before running Pulumi.",
    );
    await new Promise((r) => setTimeout(r, LAMBDA_CUR_PROPAGATION_WAIT_MS));
  }

  try {
    // Step 2.5: Diagnostic snapshot — log the role's boundary + attached
    // policies. Pure instrumentation; failures are swallowed.
    const roleName = `${config.stackPrefix}-app-${appId}-role`;
    try {
      await logAppRoleSnapshot(roleName, managerCreds);
    } catch (err) {
      console.warn(
        `[diag] snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Step 3: Role-chain to the app session so subsequent calls use the
    // freshly-broadened permissions.
    const appCreds: AwsCredentials = await roleChain([
      config.managerRoleArn,
      appRoleArn,
    ]);
    await logCallerIdentity("app session", appCreds);

    // Step 4: Pulumi up — creates DSQL, files bucket, Lambda, API Gateway.
    console.log("Running pulumi up for cloud-data-server…");
    const distZipPath = join(cloudDataServerPackageDir(), "dist.zip");
    // sourceCodeHash forces Pulumi to detect a Lambda code change on redeploy
    // even if the on-disk path is unchanged. Mirrors the per-app installer
    // (pulumi-program.ts) — without it, a fresh dist.zip may not be picked up.
    const bundleHash = createHash("sha256").update(readFileSync(distZipPath)).digest("base64");
    const program = buildCloudDataServerProgram({
      stackPrefix: config.stackPrefix,
      region: config.region,
      accountId: config.accountId,
      appRoleArn,
      distZipPath,
      bundleHash,
      userPoolId: config.userPoolId,
      userPoolClientId: config.userPoolClientId,
    });

    const outputs = await pulumiUpInline({
      stackName: `${config.stackPrefix}-cloud-data-server`,
      projectName: `${config.stackPrefix}-builtins`,
      program,
      pulumiStateBucket: config.pulumiStateBucket,
      region: config.region,
      stackPrefix: config.stackPrefix,
      awsCreds: appCreds,
      preCleanupOrphans: makeCloudDataServerOrphanCleaner(config, appCreds),
    });

    const auroraHostname = String(outputs.auroraHostname);
    const bucketName = String(outputs.bucketName);
    const apiGatewayId = String(outputs.apiGatewayId);
    const apiGatewayExecutionArn = String(outputs.apiGatewayExecutionArn);
    const apiGatewayUrl = String(outputs.apiGatewayUrl);
    const authorizerId = String(outputs.authorizerId);
    const functionArn = String(outputs.functionArn);
    const region = String(outputs.region);

    // Step 5: Initialize the shared schema against the now-existing DSQL
    // cluster. Fully idempotent — see dsql-schema-init.ts.
    console.log("Initializing shared schema…");
    await initializeSharedSchema({
      hostname: auroraHostname,
      region: config.region,
      stackPrefix: config.stackPrefix,
      credentials: {
        accessKeyId: appCreds.accessKeyId,
        secretAccessKey: appCreds.secretAccessKey,
        sessionToken: appCreds.sessionToken,
      },
    });
    console.log("Shared schema initialized.");

    // Step 6: Detach on success only. On failure we deliberately leave the
    // policy attached: PutRolePolicy resets per-service authz cache
    // propagation (S3 in particular can take several minutes), so detaching
    // on every failed run forces the next run to re-warm from zero. Leaving
    // it attached lets the warm-up complete in the background, so a retry
    // hits an already-propagated cache. The success path below detaches,
    // and a subsequent successful run will detach if a prior failure left
    // it behind (PutRolePolicy in step 2 is idempotent — same name updates
    // in place — and the detach here unconditionally removes by name).
    console.log("Detaching temp-install-cloud-data-server policy…");
    try {
      await detachTempInstallCloudDataServerPolicy(config.stackPrefix, managerCreds);
    } catch (err) {
      console.warn(
        `Could not detach temp-install-cloud-data-server policy: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {
      appRoleArn,
      auroraHostname,
      bucketName,
      apiGatewayUrl,
      apiGatewayId,
      apiGatewayExecutionArn,
      authorizerId,
      functionArn,
      region,
    };
  } catch (err) {
    console.warn(
      "Install failed; leaving temp-install-cloud-data-server policy attached " +
        "so the next run can reuse warmed IAM/S3 propagation state. " +
        "Re-run the installer to retry, or detach manually if abandoning the install.",
    );
    throw err;
  }
}

/**
 * Tear down the cloud-data-server built-in app completely.
 *
 * Steps:
 *   1. Verify the app role exists — if not, there is nothing to do.
 *   2. Attach the temp-install-cloud-data-server policy (it covers all
 *      delete-side actions: dsql:DeleteCluster, s3:DeleteBucket, etc.).
 *   3. Role-chain to the app session.
 *   4. Run `pulumi destroy` to remove all Pulumi-managed resources (DSQL
 *      cluster, files bucket, Lambda, API Gateway, CUR report).
 *   5. Delete all inline policies on the app role, then delete the role.
 *
 * Idempotent — safe to re-run if a previous attempt was interrupted.
 */
export async function uninstallCloudDataServer(
  config: CloudDataServerInstallConfig,
): Promise<void> {
  const appId = "cloud-data-server";
  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;

  const managerCreds = await roleChain([config.managerRoleArn]);

  if (!(await appRoleExists(config.stackPrefix, appId, managerCreds))) {
    console.log(`${config.stackPrefix}-app-${appId}-role not found; nothing to uninstall.`);
    return;
  }

  console.log("Attaching temp-install-cloud-data-server policy…");
  const policyUpdated = await attachTempInstallCloudDataServerPolicy(
    config.stackPrefix,
    config.accountId,
    config.region,
    managerCreds,
  );

  if (policyUpdated) {
    const PROPAGATION_WAIT_MS = 60_000;
    console.log(
      `Policy changed — waiting ${PROPAGATION_WAIT_MS / 1000}s for IAM propagation before running Pulumi.`,
    );
    await new Promise((r) => setTimeout(r, PROPAGATION_WAIT_MS));
  }

  const appCreds: AwsCredentials = await roleChain([config.managerRoleArn, appRoleArn]);

  console.log("Running pulumi destroy for cloud-data-server…");
  await pulumiDestroyInline({
    stackName: `${config.stackPrefix}-cloud-data-server`,
    projectName: `${config.stackPrefix}-builtins`,
    pulumiStateBucket: config.pulumiStateBucket,
    region: config.region,
    stackPrefix: config.stackPrefix,
    awsCreds: appCreds,
  });

  console.log("Deleting app role…");
  await deleteAppRoleWithPolicies(config.stackPrefix, appId, managerCreds);

  console.log("cloud-data-server uninstalled.");
}

/**
 * Canned manifest for the `local-data-sync` built-in cloud identity.
 *
 * The local-data-server has built-in features (notably the file watcher) that
 * originate shared-type records on behalf of the user. Those records must
 * round-trip through cloud sync, but LDS itself has no cloud presence — it's a
 * local process. `local-data-sync` is the cloud-side counterpart: an app role
 * with write access on the relevant shared types so push requests carrying
 * `originAppId: "local-data-sync"` can be STS-assumed and authorized.
 *
 * Symmetric to cloud-data-server's foundational install: paired built-in
 * identities, one local and one cloud, that together describe LDS sync.
 *
 * No compute, no app-specific syncable tables, no `unknown` ingestion (the
 * LDS resolves the type locally before write).
 */
function loadLocalDataSyncManifest() {
  return appManifestSchema.parse({
    id: LOCAL_DATA_SYNC_APP_ID,
    name: "Local Data Sync",
    version: "1.0.0",
    tier: "official",
    infraRequirements: {
      sharedTypeAccess: [
        {
          typeId: "image",
          access: "readwrite",
          rationale: "LDS file watcher ingests image files.",
        },
        {
          typeId: "markdown",
          access: "readwrite",
          rationale: "LDS file watcher ingests markdown files.",
        },
      ],
      canIngestUnknown: true,
    },
  });
}

/**
 * Install (or update) the `local-data-sync` built-in cloud identity.
 *
 * Thin wrapper over `installApp` with the canned manifest above. Must be
 * called after `installCloudDataServer` has provisioned the foundational
 * infra (DSQL, files bucket, API Gateway, install-ddl / install-infra
 * roles) — `config` carries those outputs.
 */
export async function installLocalDataSync(config: InstallerConfig): Promise<void> {
  assertCloudInstallableAppId(LOCAL_DATA_SYNC_APP_ID);
  const manifest = loadLocalDataSyncManifest();
  console.log(`\nInstalling ${LOCAL_DATA_SYNC_APP_ID}…`);
  await installApp({
    appId: LOCAL_DATA_SYNC_APP_ID,
    manifest,
    version: manifest.version,
    config,
  });
  console.log(`${LOCAL_DATA_SYNC_APP_ID} installed.`);
}

/**
 * Tear down the `local-data-sync` built-in cloud identity. Mirrors
 * `installLocalDataSync` and is invoked from `uninstallCloudDataServer`
 * (before the foundational tear-down, so the DSQL cluster still exists).
 */
export async function uninstallLocalDataSync(config: InstallerConfig): Promise<void> {
  const manifest = loadLocalDataSyncManifest();
  console.log(`\nUninstalling ${LOCAL_DATA_SYNC_APP_ID}…`);
  await uninstallApp({
    appId: LOCAL_DATA_SYNC_APP_ID,
    manifest,
    config,
  });
  console.log(`${LOCAL_DATA_SYNC_APP_ID} uninstalled.`);
}
