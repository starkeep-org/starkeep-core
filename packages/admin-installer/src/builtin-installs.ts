/**
 * Built-in app install/update entry points.
 *
 * Currently scoped to cloud-data-server. The flow mirrors the per-app installer
 * (Manager → temp-policy → Pulumi up → migrations → detach), but with two
 * structural differences:
 *
 *   1. Idempotency uses existence checks (does the role exist? is the temp
 *      policy attached?) rather than the shared.app_install_steps cloud
 *      ledger — because that table is created by the very migration this
 *      install runs. Pulumi's own state handles compute-step idempotency.
 *
 *   2. The Pulumi program is hardcoded (buildCloudDataServerProgram) rather
 *      than generated from the manifest. cloud-data-server provisions
 *      foundational resources (DSQL cluster, files bucket, API Gateway with
 *      Cognito JWT authorizer) that the per-app program shape can't express.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { roleChain, type AwsCredentials } from "./session";
import {
  appRoleExists,
  attachTempInstallCloudDataServerPolicy,
  createAppRole,
  detachTempInstallCloudDataServerPolicy,
} from "./iam";
import { pulumiUpInline } from "./compute-stack";
import { runMigrations } from "./dsql-migrations";
import { buildCloudDataServerProgram } from "./builtin-programs/cloud-data-server-program";

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
    appPrivate: { brokerPower: boolean };
    sharedTypeAccess: unknown[];
  };
  migrations: string[];
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
  authorizerId: string;
  functionArn: string;
  region: string;
  appliedMigrations: string[];
  skippedMigrations: string[];
}

/**
 * Install (or update) the cloud-data-server built-in app.
 *
 * Idempotent — safe to re-run. Each AWS-side check is an existence check,
 * each compute step is Pulumi (which natively no-ops on unchanged state),
 * each migration is keyed in shared.schema_migrations.
 *
 * On a fresh AWS account the steps are: mint role → attach temp policy →
 * pulumi up (creates DSQL/S3/Lambda/APIGw) → run migrations (creates
 * shared.records et al) → detach temp policy. On re-run: role exists (skip),
 * temp policy reattaches (idempotent PutRolePolicy), pulumi up no-ops,
 * migrations skip already-applied ids, detach succeeds.
 */
export async function installCloudDataServer(
  config: CloudDataServerInstallConfig,
): Promise<CloudDataServerInstallOutputs> {
  const manifest = loadCloudDataServerManifest();
  const appId = "cloud-data-server";
  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;

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
      brokerPower: manifest.infraRequirements.appPrivate.brokerPower,
      managerCreds,
    });
  } else {
    console.log(`${config.stackPrefix}-app-${appId}-role already exists; skipping create.`);
  }

  // Step 2: Attach the wider temp-install-cloud-data-server policy.
  console.log("Attaching temp-install-cloud-data-server policy…");
  await attachTempInstallCloudDataServerPolicy(
    config.stackPrefix,
    config.accountId,
    config.region,
    managerCreds,
  );

  try {
    // Step 3: Role-chain to the app session so subsequent calls use the
    // freshly-broadened permissions.
    const appCreds: AwsCredentials = await roleChain([
      config.managerRoleArn,
      appRoleArn,
    ]);

    // Step 4: Pulumi up — creates DSQL, files bucket, Lambda, API Gateway.
    console.log("Running pulumi up for cloud-data-server…");
    const distZipPath = join(cloudDataServerPackageDir(), "dist.zip");
    const program = buildCloudDataServerProgram({
      stackPrefix: config.stackPrefix,
      region: config.region,
      accountId: config.accountId,
      appRoleArn,
      distZipPath,
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
      appCreds,
    });

    const auroraHostname = String(outputs.auroraHostname);
    const bucketName = String(outputs.bucketName);
    const apiGatewayId = String(outputs.apiGatewayId);
    const apiGatewayUrl = String(outputs.apiGatewayUrl);
    const authorizerId = String(outputs.authorizerId);
    const functionArn = String(outputs.functionArn);
    const region = String(outputs.region);

    // Step 5: Run migrations against the now-existing DSQL cluster.
    console.log(`Running migrations: ${manifest.migrations.join(", ")}`);
    const migrationsDir = join(cloudDataServerPackageDir(), "migrations");
    const { applied, skipped } = await runMigrations(
      {
        hostname: auroraHostname,
        region: config.region,
        stackPrefix: config.stackPrefix,
        credentials: {
          accessKeyId: appCreds.accessKeyId,
          secretAccessKey: appCreds.secretAccessKey,
          sessionToken: appCreds.sessionToken,
        },
      },
      migrationsDir,
      manifest.migrations,
    );
    console.log(`Migrations applied: [${applied.join(", ")}], skipped: [${skipped.join(", ")}]`);

    return {
      appRoleArn,
      auroraHostname,
      bucketName,
      apiGatewayUrl,
      apiGatewayId,
      authorizerId,
      functionArn,
      region,
      appliedMigrations: applied,
      skippedMigrations: skipped,
    };
  } finally {
    // Step 6: Always try to detach the temp policy, even on failure, so a
    // crashed install doesn't leave wide perms attached. Safe if already
    // detached — DeleteRolePolicy errors here are logged but not rethrown.
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
  }
}
