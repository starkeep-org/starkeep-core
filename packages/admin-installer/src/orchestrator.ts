/**
 * Install/uninstall state machine for Starkeep apps.
 *
 * Each step is idempotent: completed steps (status='done' in app_install_steps)
 * are skipped on retry. Steps are recorded before execution (pending) and after
 * (done or failed).
 *
 * This runs in a local pnpm CLI subprocess that admin-web spawns from its
 * Next.js API routes (see apps/admin-web/app/api/.../install/route.ts). The
 * caller passes credentials it obtained by signing the operator in to Cognito
 * and assuming the admin-app role in the operator's AWS account; the manager
 * role is assumed from there as the first hop of the role chain.
 *
 * Built-in apps (cloud-data-server, starkeep-drive) follow a parallel install
 * path in ./builtin-installs.ts. They use hardcoded Pulumi programs instead of
 * the manifest-driven flow here because they provision foundational resources
 * (DSQL cluster, shared bucket, API Gateway) that the per-app shape can't
 * express, and they bootstrap the shared step ledger rather than reading it.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  assertNotReservedAppId,
} from "./iam";
import {
  appCredsParameterName,
  deleteAppCredsParameter,
  putAppCredsParameter,
} from "./app-creds";
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
import { createDsqlRegistry, type Registry } from "./registry";

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
  /**
   * Base URL of the shared HTTP API Gateway (the cloud-data-server's stage
   * URL). Injected into per-app Lambdas as STARKEEP_CLOUD_DATA_BASE so that
   * @starkeep/app-client's cloud mode can route signed calls back through
   * `/apps/<appId>/...` on the same gateway.
   */
  apiGatewayUrl: string;
  permissionsBoundaryArn: string;
  foundationalPermissionsBoundaryArn: string;
  userDataOwnerPermissionsBoundaryArn: string;
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
  /**
   * Admin-app credentials used by the registry to authenticate to DSQL as
   * `${stackPrefix}_installer` (see registry.ts). These are the same ambient
   * creds the orchestrator inherits via roleChain — the federated session the
   * human admin established when they invoked the install. Doesn't carry
   * `expiration` because DSQL signing only needs the static fields; the
   * orchestrator's role-chained creds carry it but this surface is broader.
   */
  registryCredentials: RegistryCredentials;
  /**
   * Set by built-in install wrappers (currently Starkeep Drive) to claim a
   * reserved app id. Third-party installs leave it unset and are rejected on
   * reserved ids.
   */
  allowReservedAppId?: boolean;
}

export interface RegistryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface UninstallInput {
  appId: string;
  manifest: AppManifest;
  config: InstallerConfig;
  registryCredentials: RegistryCredentials;
}

export interface InstallResult {
  appRoleArn: string;
  receipt: InstallReceipt | null;
}

async function runStep(
  registry: Registry,
  appId: string,
  operation: "install" | "uninstall",
  stepName: string,
  done: Set<string>,
  fn: () => Promise<void>,
): Promise<void> {
  if (done.has(stepName)) return;
  await registry.recordStep(appId, operation, stepName, "pending");
  try {
    await fn();
    await registry.recordStep(appId, operation, stepName, "done");
    done.add(stepName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await registry.recordStep(appId, operation, stepName, "failed", msg);
    throw err;
  }
}

export async function installApp(input: InstallInput): Promise<InstallResult> {
  assertCloudInstallableAppId(input.appId);
  if (!input.allowReservedAppId) assertNotReservedAppId(input.appId);
  const { config } = input;
  const registry = createDsqlRegistry({
    hostname: config.dsqlHostname,
    region: config.region,
    stackPrefix: config.stackPrefix,
    credentials: input.registryCredentials,
  });
  try {
    return await installAppInner(input, registry);
  } finally {
    await registry.close();
  }
}

async function installAppInner(
  input: InstallInput,
  registry: Registry,
): Promise<InstallResult> {
  const { appId, manifest, zipBuffer, config } = input;
  const ir = manifest.infraRequirements;
  const done = await registry.getCompletedSteps(appId, "install");

  const managerCreds = await roleChain([config.managerRoleArn]);

  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;

  // SSM provisioning step: mirror the local HMAC secret to a SecureString at
  // /${stackPrefix}/app-creds/${appId}. The cloud-data-server verifier reads
  // from here; the supervisor (locally) signs with the same secret loaded
  // from the local creds file, so both sides agree. The local creds file is
  // authoritative — its presence is required (it's written by admin-web on
  // local install). On first cloud install if no local file exists we mint a
  // fresh secret and write the local file ourselves so the symmetry holds.
  const hmacSecret = ensureLocalHmacSecret(appId);
  await runStep(registry, appId, "install", "put_app_creds_parameter", done, () =>
    putAppCredsParameter({
      stackPrefix: config.stackPrefix,
      appId,
      hmacSecret,
      region: config.region,
      awsCreds: managerCreds,
    }).then(() => undefined),
  );

  await runStep(registry, appId, "install", "create_iam_role", done, async () => {
    await createAppRole({
      stackPrefix: config.stackPrefix,
      appId,
      accountId: config.accountId,
      permissionsBoundaryArn: config.permissionsBoundaryArn,
      foundationalPermissionsBoundaryArn: config.foundationalPermissionsBoundaryArn,
      userDataOwnerPermissionsBoundaryArn: config.userDataOwnerPermissionsBoundaryArn,
      fileAccess: ir.fileAccess,
      fileAccessAll: ir.fileAccessAll,
      brokerPower: ir.brokerPower,
      managerCreds,
    });
  });

  await runStep(registry, appId, "install", "attach_temp_install_ddl_policy", done, () =>
    attachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
  );

  await runStep(registry, appId, "install", "run_dsql_ddl", done, async () => {
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
      ir.fileAccess,
      ir.fileAccessAll,
      ir.appSpecificSyncable.tables,
      ir.appSpecificSyncable.files,
    );
  });

  await runStep(registry, appId, "install", "detach_temp_install_ddl_policy", done, () =>
    detachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
  );

  // App creds: derived fresh (not persisted) — always re-assume on resume.
  // The per-app role's runtime policy (attached at createAppRole time) covers
  // the data-plane writes done by this orchestrator step (put_s3_keep_file).
  const appCreds: AwsCredentials = await roleChain([config.managerRoleArn, appRoleArn]);

  await runStep(registry, appId, "install", "put_s3_keep_file", done, () =>
    putAppKeepFile(config.stackPrefix, appId, config.filesBucket, config.region, appCreds),
  );

  let receipt: InstallReceipt | null = null;
  if (ir.compute.enabled) {
    // install-infra owns the install-time AWS-provisioning grants (bundle
    // upload + Pulumi up). Attach the per-app temp policy on install-infra,
    // run upload + compute stack as install-infra, then detach. A bundle
    // without compute would have nothing to upload it for, so the gate is
    // strictly on `compute.enabled`.
    await runStep(registry, appId, "install", "attach_temp_install_infra_policy", done, () =>
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
      await runStep(registry, appId, "install", "upload_bundle", done, () =>
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
      await runStep(registry, appId, "install", "install_compute_stack", done, async () => {
        const bundleHash = zipBuffer
          ? createHash("sha256").update(zipBuffer).digest("base64")
          : undefined;
        const computeCtx: ComputeContext = {
          stackPrefix: config.stackPrefix,
          appId,
          appRoleArn,
          apiGatewayId: config.apiGatewayId,
          apiGatewayExecutionArn: config.apiGatewayExecutionArn,
          apiGatewayUrl: config.apiGatewayUrl,
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

    await runStep(registry, appId, "install", "detach_temp_install_infra_policy", done, () =>
      detachTempInstallInfraPolicy(config.stackPrefix, appId, managerCreds),
    );
  }

  await runStep(registry, appId, "install", "register_app", done, () =>
    registry.registerApp(manifest, appId),
  );

  return { appRoleArn, receipt };
}

export async function uninstallApp(input: UninstallInput): Promise<void> {
  const { config } = input;
  const registry = createDsqlRegistry({
    hostname: config.dsqlHostname,
    region: config.region,
    stackPrefix: config.stackPrefix,
    credentials: input.registryCredentials,
  });
  try {
    await uninstallAppInner(input, registry);
  } finally {
    await registry.close();
  }
}

async function uninstallAppInner(
  input: UninstallInput,
  registry: Registry,
): Promise<void> {
  const { appId, manifest, config } = input;
  const ir = manifest.infraRequirements;
  const done = await registry.getCompletedSteps(appId, "uninstall");

  const managerCreds = await roleChain([config.managerRoleArn]);
  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;

  if (ir.compute.enabled) {
    await runStep(registry, appId, "uninstall", "attach_temp_uninstall_infra_policy", done, () =>
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

    await runStep(registry, appId, "uninstall", "uninstall_compute_stack", done, () => {
      const computeCtx: ComputeContext = {
        stackPrefix: config.stackPrefix,
        appId,
        appRoleArn,
        apiGatewayId: config.apiGatewayId,
        apiGatewayExecutionArn: config.apiGatewayExecutionArn,
        apiGatewayUrl: config.apiGatewayUrl,
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

    await runStep(registry, appId, "uninstall", "delete_s3_artifacts", done, () =>
      deleteAppArtifactsObjects(appId, config.artifactsBucket, config.region, infraCreds),
    );

    await runStep(registry, appId, "uninstall", "detach_temp_uninstall_infra_policy", done, () =>
      detachTempUninstallInfraPolicy(config.stackPrefix, appId, managerCreds),
    );
  }

  // Files-bucket cleanup runs under the app's role (its runtime policy +
  // permissions boundary scope it to apps/<appId>/*).
  const appCreds: AwsCredentials = await roleChain([config.managerRoleArn, appRoleArn]);

  await runStep(registry, appId, "uninstall", "delete_s3_files", done, () =>
    deleteAppFilesObjects(appId, config.filesBucket, config.region, appCreds),
  );

  await runStep(registry, appId, "uninstall", "attach_temp_install_ddl_policy", done, () =>
    attachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
  );

  await runStep(registry, appId, "uninstall", "run_dsql_uninstall_ddl", done, async () => {
    const ddlCreds = await roleChain([config.managerRoleArn, config.installDdlRoleArn]);
    const dsqlOpts: DsqlDdlOptions = {
      hostname: config.dsqlHostname,
      region: config.region,
      stackPrefix: config.stackPrefix,
      accountId: config.accountId,
      credentials: ddlCreds,
    };
    await runAppUninstallDdl(dsqlOpts, appId, ir.fileAccess, ir.fileAccessAll);
  });

  await runStep(registry, appId, "uninstall", "detach_temp_install_ddl_policy", done, () =>
    detachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
  );

  await runStep(registry, appId, "uninstall", "delete_app_registry", done, () =>
    registry.deleteAppRegistryEntry(appId),
  );

  await runStep(registry, appId, "uninstall", "delete_iam_role", done, () =>
    deleteAppRole(config.stackPrefix, appId, managerCreds),
  );

  await runStep(registry, appId, "uninstall", "delete_app_creds_parameter", done, () =>
    deleteAppCredsParameter({
      stackPrefix: config.stackPrefix,
      appId,
      region: config.region,
      awsCreds: managerCreds,
    }),
  );
}

/**
 * Read the per-app HMAC secret from the local creds file
 * (`~/.starkeep/app-creds/${appId}.json`) — the same file `@starkeep/app-client`
 * loads at runtime. The local install (via admin-web) writes it. If the file
 * is missing we mint a fresh secret; the caller is responsible for ensuring
 * the local install runs first if local–cloud parity matters.
 *
 * Side-effect: returns the secret only; does NOT write the local file. (Cloud
 * install runs against an existing local install in normal flows; minting
 * here would diverge from the local registry's hmac_secret.)
 */
function ensureLocalHmacSecret(appId: string): string {
  const dataDir = process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");
  const credsPath = join(dataDir, "app-creds", `${appId}.json`);
  if (existsSync(credsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(credsPath, "utf-8")) as {
        hmacSecret?: string;
      };
      if (parsed.hmacSecret) return parsed.hmacSecret;
    } catch {
      // fall through to mint
    }
  }
  // Fallback: mint a fresh 32-byte secret. Used only when no local creds
  // file exists (e.g. cloud-only install in a fresh environment). The cloud
  // verifier and any future caller fetching from SSM will see this value.
  return randomBytes(32).toString("hex");
}

// Re-export so call sites (cli scripts, admin-web) can name the SSM parameter
// without reaching into ./app-creds directly.
export { appCredsParameterName };
