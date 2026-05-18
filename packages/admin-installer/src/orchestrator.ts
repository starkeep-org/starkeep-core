/**
 * Install/uninstall state machine for Starkeep apps.
 *
 * Each step is idempotent: completed steps (status='done' in app_install_steps)
 * are skipped on retry. Steps are recorded before execution (pending) and after
 * (done or failed).
 *
 * This runs inside the admin-app Lambda — ambient AWS credentials are the
 * admin-app role. The manager role is assumed as the first hop.
 */

import type { AppManifest } from "@starkeep/admin-manifest";
import { roleChain, type AwsCredentials } from "./session";
import {
  createAppRole,
  attachTempInstallPolicy,
  detachTempInstallPolicy,
  attachTempUninstallPolicy,
  detachTempUninstallPolicy,
  deleteAppRole,
} from "./iam";
import { runAppInstallDdl, runAppUninstallDdl, type DsqlDdlOptions } from "./dsql-ddl";
import { putAppKeepFile, uploadAppBundle, deleteAppObjects } from "./s3";
import {
  installComputeStack,
  uninstallComputeStack,
  type ComputeContext,
  type InstallReceipt,
} from "./compute-stack";
import {
  recordStep,
  getCompletedSteps,
  registerApp,
  createAccessPolicies,
  revokeAccessPolicies,
  deleteAppRegistryEntry,
} from "./registry";

export interface InstallerConfig {
  stackPrefix: string;
  region: string;
  accountId: string;
  dsqlHostname: string;
  filesBucket: string;
  artifactsBucket: string;
  pulumiStateBucket: string;
  apiGatewayId: string;
  authorizerId: string;
  permissionsBoundaryArn: string;
  foundationalPermissionsBoundaryArn: string;
  managerRoleArn: string;
}

export interface InstallInput {
  appId: string;
  manifest: AppManifest;
  zipBuffer: Buffer;
  version: string;
  config: InstallerConfig;
}

export interface UninstallInput {
  appId: string;
  manifest: AppManifest;
  config: InstallerConfig;
}

export interface InstallResult {
  appRoleArn: string;
  receipt: InstallReceipt | null;
}

async function runStep(
  appId: string,
  operation: "install" | "uninstall",
  stepName: string,
  done: Set<string>,
  fn: () => Promise<void>,
): Promise<void> {
  if (done.has(stepName)) return;
  await recordStep(appId, operation, stepName, "pending");
  try {
    await fn();
    await recordStep(appId, operation, stepName, "done");
    done.add(stepName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordStep(appId, operation, stepName, "failed", msg);
    throw err;
  }
}

export async function installApp(input: InstallInput): Promise<InstallResult> {
  const { appId, manifest, zipBuffer, version, config } = input;
  const ir = manifest.infraRequirements;
  const done = await getCompletedSteps(appId, "install");

  const managerCreds = await roleChain([config.managerRoleArn]);

  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;

  await runStep(appId, "install", "create_iam_role", done, async () => {
    await createAppRole({
      stackPrefix: config.stackPrefix,
      appId,
      accountId: config.accountId,
      permissionsBoundaryArn: config.permissionsBoundaryArn,
      foundationalPermissionsBoundaryArn: config.foundationalPermissionsBoundaryArn,
      sharedTypeAccess: ir.sharedTypeAccess,
      canIngestUnknown: ir.canIngestUnknown,
      canPromoteFromUnknown: ir.canPromoteFromUnknown,
      brokerPower: ir.brokerPower,
      managerCreds,
    });
  });

  await runStep(appId, "install", "attach_temp_install_policy", done, () =>
    attachTempInstallPolicy(config.stackPrefix, appId, config.accountId, config.region, managerCreds),
  );

  // App creds: derived fresh (not persisted) — always re-assume on resume
  const appCreds: AwsCredentials = await roleChain([config.managerRoleArn, appRoleArn]);

  const dsqlOpts: DsqlDdlOptions = {
    hostname: config.dsqlHostname,
    region: config.region,
    stackPrefix: config.stackPrefix,
    credentials: {
      accessKeyId: appCreds.accessKeyId,
      secretAccessKey: appCreds.secretAccessKey,
      sessionToken: appCreds.sessionToken,
    },
  };

  await runStep(appId, "install", "run_dsql_ddl", done, () =>
    runAppInstallDdl(
      dsqlOpts,
      appId,
      ir.sharedTypeAccess,
      ir.canIngestUnknown,
      ir.canPromoteFromUnknown,
      ir.appSpecificSyncable.tables,
      ir.appSpecificSyncable.files,
    ),
  );

  await runStep(appId, "install", "put_s3_keep_file", done, () =>
    putAppKeepFile(config.stackPrefix, appId, config.filesBucket, config.region, appCreds),
  );

  await runStep(appId, "install", "upload_bundle", done, () =>
    uploadAppBundle(config.stackPrefix, appId, version, config.artifactsBucket, zipBuffer, config.region, appCreds),
  );

  let receipt: InstallReceipt | null = null;
  if (ir.compute.enabled) {
    await runStep(appId, "install", "install_compute_stack", done, async () => {
      const computeCtx: ComputeContext = {
        stackPrefix: config.stackPrefix,
        appId,
        appRoleArn,
        apiGatewayId: config.apiGatewayId,
        authorizerId: config.authorizerId,
        region: config.region,
        accountId: config.accountId,
        pulumiStateBucket: config.pulumiStateBucket,
        appCreds,
      };
      receipt = await installComputeStack(manifest, computeCtx);
    });
  }

  await runStep(appId, "install", "detach_temp_install_policy", done, () =>
    detachTempInstallPolicy(config.stackPrefix, appId, managerCreds),
  );

  let policyIds: string[] = [];
  await runStep(appId, "install", "create_access_policies", done, async () => {
    policyIds = await createAccessPolicies(appId, ir.sharedTypeAccess);
  });

  await runStep(appId, "install", "register_app", done, () =>
    registerApp(manifest, appId, policyIds),
  );

  return { appRoleArn, receipt };
}

export async function uninstallApp(input: UninstallInput): Promise<void> {
  const { appId, manifest, config } = input;
  const ir = manifest.infraRequirements;
  const done = await getCompletedSteps(appId, "uninstall");

  const managerCreds = await roleChain([config.managerRoleArn]);
  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;

  await runStep(appId, "uninstall", "attach_temp_uninstall_policy", done, () =>
    attachTempUninstallPolicy(config.stackPrefix, appId, config.accountId, config.region, managerCreds),
  );

  const appCreds: AwsCredentials = await roleChain([config.managerRoleArn, appRoleArn]);

  if (ir.compute.enabled) {
    await runStep(appId, "uninstall", "uninstall_compute_stack", done, () => {
      const computeCtx: ComputeContext = {
        stackPrefix: config.stackPrefix,
        appId,
        appRoleArn,
        apiGatewayId: config.apiGatewayId,
        authorizerId: config.authorizerId,
        region: config.region,
        accountId: config.accountId,
        pulumiStateBucket: config.pulumiStateBucket,
        appCreds,
      };
      return uninstallComputeStack(computeCtx);
    });
  }

  await runStep(appId, "uninstall", "delete_s3_objects", done, () =>
    deleteAppObjects(appId, config.filesBucket, config.artifactsBucket, config.region, appCreds),
  );

  const dsqlOpts: DsqlDdlOptions = {
    hostname: config.dsqlHostname,
    region: config.region,
    stackPrefix: config.stackPrefix,
    credentials: {
      accessKeyId: appCreds.accessKeyId,
      secretAccessKey: appCreds.secretAccessKey,
      sessionToken: appCreds.sessionToken,
    },
  };

  await runStep(appId, "uninstall", "run_dsql_uninstall_ddl", done, () =>
    runAppUninstallDdl(dsqlOpts, appId, ir.sharedTypeAccess),
  );

  await runStep(appId, "uninstall", "detach_temp_uninstall_policy", done, () =>
    detachTempUninstallPolicy(config.stackPrefix, appId, managerCreds),
  );

  await runStep(appId, "uninstall", "revoke_access_policies", done, () =>
    revokeAccessPolicies(appId),
  );

  await runStep(appId, "uninstall", "delete_app_registry", done, () =>
    deleteAppRegistryEntry(appId),
  );

  await runStep(appId, "uninstall", "delete_iam_role", done, () =>
    deleteAppRole(config.stackPrefix, appId, managerCreds),
  );
}
