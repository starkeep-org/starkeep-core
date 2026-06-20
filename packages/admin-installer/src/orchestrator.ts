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

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataDbPath, appCredsPath } from "@starkeep/app-client";
import { appRegistryRow } from "./local/registry";
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
  deleteAppRoleWithPolicies,
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
  opts?: { alwaysRun?: boolean },
): Promise<void> {
  // Most steps are skipped once recorded "done" so a resumed install doesn't
  // repeat completed (and possibly non-idempotent) work. A step flagged
  // alwaysRun reconciles every time instead — used where the desired cloud
  // state can drift from a completed record (e.g. the local HMAC secret was
  // re-minted) and the step is cheap and idempotent.
  if (!opts?.alwaysRun && done.has(stepName)) return;
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
  // from here; the sync supervisor (locally) signs with the *local registry's*
  // hmac_secret (makeSignerFor → shared_app_registry), so SSM must hold that
  // exact value. `resolveLocalHmacSecret` reads it straight from the registry
  // — the single source of truth — rather than a separately-minted creds file,
  // which is how the cloud verifier used to end up on a key no local signer
  // held (todo 39: built-in Drive's registry secret was minted at LDS startup,
  // yet cloud install minted a *different* secret into SSM → every signed
  // request 401'd "Invalid signature").
  const hmacSecret = resolveLocalHmacSecret(appId);
  // alwaysRun: reconcile SSM to the current local secret every time. A
  // completed record doesn't guarantee SSM still matches — if the local secret
  // was re-minted, a skipped mirror would leave the cloud verifier on a stale
  // key and every signed request would 401. The put is idempotent.
  await runStep(
    registry,
    appId,
    "install",
    "put_app_creds_parameter",
    done,
    () =>
      putAppCredsParameter({
        stackPrefix: config.stackPrefix,
        appId,
        hmacSecret,
        region: config.region,
        awsCreds: managerCreds,
      }).then(() => undefined),
    { alwaysRun: true },
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
    // The app role carries inline policies (runtime, broker-power); DeleteRole
    // fails with DeleteConflict unless they're removed first.
    deleteAppRoleWithPolicies(config.stackPrefix, appId, managerCreds),
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
 * Resolve the per-app HMAC secret to mirror to cloud SSM, sourced from the
 * local registry (`shared_app_registry.hmac_secret`).
 *
 * The registry secret is the single source of truth: it's the exact value the
 * sync supervisor signs cloud-bound requests with (`makeSignerFor` →
 * `appRegistryRow`), so it's the only value that can make the cloud verifier
 * agree. Mirroring anything else is the todo-39 drift: the previous
 * implementation read/minted a *separate* creds file, so a built-in app
 * (Drive) whose registry secret was minted at LDS startup got a freshly-minted,
 * *different* secret in SSM — every signed request then 401'd "Invalid
 * signature", and no reinstall could converge them because the two stores were
 * never tied together.
 *
 * Side effect: reconcile the local creds file (`~/.starkeep/app-creds/
 * ${appId}.json`, what `@starkeep/app-client` and the app→LDS HMAC path read)
 * to the registry value too, so all three stores (registry, creds file, SSM)
 * hold one key. Built-in apps never go through admin-web's local-install route,
 * so this is also where their creds file first gets written.
 *
 * If the app has no local registry row the supervisor can't sign for it at all;
 * minting a secret for the cloud side would only recreate the drift, so we fail
 * loudly and direct the operator to install the app locally first.
 */
function resolveLocalHmacSecret(appId: string): string {
  // The local-data-server stores its sqlite DB at `${STARKEEP_DIR}/data.db`
  // (server.ts). `dataDbPath()` resolves the same root, so we open the same file.
  const dbPath = dataDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Cannot mirror the HMAC secret for "${appId}" to SSM: local data store ` +
        `${dbPath} not found. Start the local-data-server and install "${appId}" ` +
        `locally before installing it in the cloud.`,
    );
  }

  // The LDS holds this DB open; we only need a single SELECT. A busy timeout
  // rides out the brief window where the LDS might hold a write lock. (We can't
  // pass `{ readOnly: true }` — this package pins @types/node 22.10, predating
  // that option — but existsSync above guarantees we won't create the file, and
  // the lookup never writes.)
  const db = new DatabaseSync(dbPath);
  let secret: string | null;
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    secret = appRegistryRow(db, appId)?.hmacSecret ?? null;
  } finally {
    db.close();
  }
  if (!secret) {
    throw new Error(
      `Cannot mirror the HMAC secret for "${appId}" to SSM: no ` +
        `shared_app_registry row for "${appId}". Install "${appId}" locally ` +
        `first so the secret the sync supervisor signs with is the one mirrored ` +
        `to the cloud.`,
    );
  }

  reconcileLocalCredsFile(appId, secret);
  return secret;
}

/**
 * Bring the local creds file in line with the registry secret. Preserves an
 * existing `dataServerUrl` (admin-web writes it at local install); a fresh file
 * (e.g. for a built-in app) omits it and `@starkeep/app-client` falls back to
 * its localhost default. No-op when the file already holds the right secret.
 */
function reconcileLocalCredsFile(appId: string, hmacSecret: string): void {
  const credsPath = appCredsPath(appId);
  const credsDir = dirname(credsPath);
  let dataServerUrl: string | undefined;
  if (existsSync(credsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(credsPath, "utf-8")) as {
        hmacSecret?: string;
        dataServerUrl?: string;
      };
      if (parsed.hmacSecret === hmacSecret) return; // already converged
      dataServerUrl = parsed.dataServerUrl;
    } catch {
      // Unreadable/corrupt — fall through and rewrite it.
    }
  }
  const payload: Record<string, string> = { appId, hmacSecret };
  if (dataServerUrl) payload.dataServerUrl = dataServerUrl;
  mkdirSync(credsDir, { recursive: true, mode: 0o700 });
  writeFileSync(credsPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

// Re-export so call sites (cli scripts, admin-web) can name the SSM parameter
// without reaching into ./app-creds directly.
export { appCredsParameterName };
