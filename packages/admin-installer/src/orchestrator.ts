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

import { createHash } from "node:crypto";
import type { AppManifest } from "@starkeep/admin-manifest";
import { roleChain, type AwsCredentials } from "./session";
import {
  createAppRole,
  attachTempInstallInfraPolicy,
  detachTempInstallInfraPolicy,
  attachTempUninstallInfraPolicy,
  detachTempUninstallInfraPolicy,
  attachTempInstallDdlPolicy,
  detachTempInstallDdlPolicy,
  deleteAppRole,
  assertCloudInstallableAppId,
} from "./iam";
import { runAppInstallDdl, runAppUninstallDdl, type DsqlDdlOptions } from "./dsql-ddl";
import {
  putAppKeepFile,
  uploadAppBundle,
  deleteAppFilesObjects,
  deleteAppArtifactsObjects,
} from "./s3";
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
  /**
   * API Gateway execution ARN, used as the source-arn on
   * aws.lambda.Permission so apigateway.amazonaws.com can invoke per-app
   * Lambdas. Format: arn:aws:execute-api:<region>:<account>:<apiId>
   */
  apiGatewayExecutionArn: string;
  authorizerId: string;
  permissionsBoundaryArn: string;
  foundationalPermissionsBoundaryArn: string;
  managerRoleArn: string;
  installDdlRoleArn: string;
  installInfraRoleArn: string;
}

export interface InstallInput {
  appId: string;
  manifest: AppManifest;
  zipBuffer?: Buffer;
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
  const { appId, manifest, zipBuffer, config } = input;
  assertCloudInstallableAppId(appId);
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

  await runStep(appId, "install", "attach_temp_install_ddl_policy", done, () =>
    attachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
  );

  await runStep(appId, "install", "run_dsql_ddl", done, async () => {
    const ddlCreds = await roleChain([config.managerRoleArn, config.installDdlRoleArn]);
    const dsqlOpts: DsqlDdlOptions = {
      hostname: config.dsqlHostname,
      region: config.region,
      stackPrefix: config.stackPrefix,
      accountId: config.accountId,
      credentials: ddlCreds,
    };
    await runAppInstallDdl(
      dsqlOpts,
      appId,
      ir.sharedTypeAccess,
      ir.canIngestUnknown,
      ir.canPromoteFromUnknown,
      ir.appSpecificSyncable.tables,
      ir.appSpecificSyncable.files,
    );
  });

  await runStep(appId, "install", "detach_temp_install_ddl_policy", done, () =>
    detachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
  );

  // App creds: derived fresh (not persisted) — always re-assume on resume.
  // The per-app role's runtime policy (attached at createAppRole time) covers
  // the data-plane writes done by this orchestrator step (put_s3_keep_file).
  const appCreds: AwsCredentials = await roleChain([config.managerRoleArn, appRoleArn]);

  await runStep(appId, "install", "put_s3_keep_file", done, () =>
    putAppKeepFile(config.stackPrefix, appId, config.filesBucket, config.region, appCreds),
  );

  let receipt: InstallReceipt | null = null;
  if (zipBuffer || ir.compute.enabled) {
    // install-infra owns the install-time AWS-provisioning grants (bundle
    // upload + Pulumi up). Attach the per-app temp policy on install-infra,
    // run upload + compute stack as install-infra, then detach.
    await runStep(appId, "install", "attach_temp_install_infra_policy", done, () =>
      attachTempInstallInfraPolicy(
        config.stackPrefix,
        appId,
        config.accountId,
        config.region,
        managerCreds,
      ),
    );

    const infraCreds: AwsCredentials = await roleChain([
      config.managerRoleArn,
      config.installInfraRoleArn,
    ]);

    if (zipBuffer) {
      await runStep(appId, "install", "upload_bundle", done, () =>
        uploadAppBundle(
          config.stackPrefix,
          appId,
          config.artifactsBucket,
          zipBuffer,
          config.region,
          infraCreds,
        ),
      );
    }

    if (ir.compute.enabled) {
      await runStep(appId, "install", "install_compute_stack", done, async () => {
        const bundleHash = zipBuffer
          ? createHash("sha256").update(zipBuffer).digest("base64")
          : undefined;
        const computeCtx: ComputeContext = {
          stackPrefix: config.stackPrefix,
          appId,
          appRoleArn,
          apiGatewayId: config.apiGatewayId,
          apiGatewayExecutionArn: config.apiGatewayExecutionArn,
          authorizerId: config.authorizerId,
          region: config.region,
          accountId: config.accountId,
          pulumiStateBucket: config.pulumiStateBucket,
          artifactsBucket: config.artifactsBucket,
          dsqlHostname: config.dsqlHostname,
          filesBucket: config.filesBucket,
          infraCreds,
          bundleHash,
        };
        receipt = await installComputeStack(manifest, computeCtx);
      });
    }

    await runStep(appId, "install", "detach_temp_install_infra_policy", done, () =>
      detachTempInstallInfraPolicy(config.stackPrefix, appId, managerCreds),
    );
  }

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

  if (ir.compute.enabled) {
    await runStep(appId, "uninstall", "attach_temp_uninstall_infra_policy", done, () =>
      attachTempUninstallInfraPolicy(
        config.stackPrefix,
        appId,
        config.accountId,
        config.region,
        managerCreds,
      ),
    );

    const infraCreds: AwsCredentials = await roleChain([
      config.managerRoleArn,
      config.installInfraRoleArn,
    ]);

    await runStep(appId, "uninstall", "uninstall_compute_stack", done, () => {
      const computeCtx: ComputeContext = {
        stackPrefix: config.stackPrefix,
        appId,
        appRoleArn,
        apiGatewayId: config.apiGatewayId,
        apiGatewayExecutionArn: config.apiGatewayExecutionArn,
        authorizerId: config.authorizerId,
        region: config.region,
        accountId: config.accountId,
        pulumiStateBucket: config.pulumiStateBucket,
        artifactsBucket: config.artifactsBucket,
        dsqlHostname: config.dsqlHostname,
        filesBucket: config.filesBucket,
        infraCreds,
      };
      return uninstallComputeStack(computeCtx);
    });

    await runStep(appId, "uninstall", "delete_s3_artifacts", done, () =>
      deleteAppArtifactsObjects(appId, config.artifactsBucket, config.region, infraCreds),
    );

    await runStep(appId, "uninstall", "detach_temp_uninstall_infra_policy", done, () =>
      detachTempUninstallInfraPolicy(config.stackPrefix, appId, managerCreds),
    );
  }

  // Files-bucket cleanup runs under the app's role (its runtime policy +
  // permissions boundary scope it to apps/<appId>/*).
  const appCreds: AwsCredentials = await roleChain([config.managerRoleArn, appRoleArn]);

  await runStep(appId, "uninstall", "delete_s3_files", done, () =>
    deleteAppFilesObjects(appId, config.filesBucket, config.region, appCreds),
  );

  await runStep(appId, "uninstall", "attach_temp_install_ddl_policy", done, () =>
    attachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
  );

  await runStep(appId, "uninstall", "run_dsql_uninstall_ddl", done, async () => {
    const ddlCreds = await roleChain([config.managerRoleArn, config.installDdlRoleArn]);
    const dsqlOpts: DsqlDdlOptions = {
      hostname: config.dsqlHostname,
      region: config.region,
      stackPrefix: config.stackPrefix,
      accountId: config.accountId,
      credentials: ddlCreds,
    };
    await runAppUninstallDdl(dsqlOpts, appId, ir.sharedTypeAccess);
  });

  await runStep(appId, "uninstall", "detach_temp_install_ddl_policy", done, () =>
    detachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
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
