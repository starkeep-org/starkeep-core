/**
 * Install/uninstall state machine for Starkeep apps.
 *
 * Each step is idempotent: completed steps (status='done' in app_install_steps)
 * are skipped on retry. Steps are recorded before execution (pending) and after
 * (done or failed).
 *
 * This runs in a local pnpm CLI subprocess that admin-web spawns from its
 * install routes (see apps/admin-web/src/routes/apps-install.ts). The
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

import { DatabaseSync } from "node:sqlite";
import type { RawDatabase } from "@starkeep/storage-adapter";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataDbPath, appCredsPath } from "@starkeep/app-client";
import { appRegistryRow } from "./local/registry";
import type { AppManifest } from "@starkeep/admin-manifest";
import { roleChain, type AwsCredentials } from "./session";
import {
  createAppRole,
  createAppExecRole,
  appExecRoleName,
  attachTempInstallInfraPolicy,
  detachTempInstallInfraPolicy,
  attachTempUninstallInfraPolicy,
  detachTempUninstallInfraPolicy,
  attachTempInstallDdlPolicy,
  detachTempInstallDdlPolicy,
  deleteAppRoleWithPolicies,
  deleteAppExecRoleWithPolicies,
  assertCloudInstallableAppId,
  assertNotReservedAppId,
} from "./iam";
import { appCredsParameterName, deleteAppCredsParameter, putAppCredsParameter } from "./app-creds";
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
import { createDsqlRegistry, type AppSurface, type Registry } from "./registry";
import { setMobileAppCallback } from "./app-sign-in-clients";

/**
 * The mobile build's callback on the mobile-apps client, for an app that ships
 * one, or null when nothing needs doing. Throws for a mobile build on a
 * deployment with no mobile-apps client, which a reinstall of the cloud data
 * server creates.
 */
function mobileCallbackTarget(
  manifest: AppManifest,
  config: InstallerConfig,
): {
  scheme: string;
  pool: { region: string; userPoolId: string; mobileAppsClientId: string };
} | null {
  const scheme = manifest.mobile?.android?.callbackScheme;
  if (!scheme) return null;
  if (!config.mobileSignIn) {
    throw new Error(
      `${manifest.id} ships a mobile build, but this deployment has no mobile-apps client. ` +
        "Reinstall the cloud data server first.",
    );
  }
  return { scheme, pool: { region: config.region, ...config.mobileSignIn } };
}

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
  /** See ComputeContext.sessionAuthorizerId — absent on a pre-authorizer stack. */
  sessionAuthorizerId?: string;
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
  /**
   * The user pool and its mobile-apps client, for an app that ships a mobile
   * build: install registers the build's callback on the client, and
   * uninstall removes it. Absent for a deployment whose cloud data server
   * install predates the client.
   */
  mobileSignIn?: { userPoolId: string; mobileAppsClientId: string };
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
  /**
   * The surfaces to install on top of the data side. Omitted, every surface
   * the manifest offers ({@link manifestSurfaces}); empty, the data side
   * alone. A surface the manifest does not offer is refused.
   */
  surfaces?: readonly AppSurface[];
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
  /**
   * Remove only these surfaces and keep the data side, which the other
   * surface or the desktop's sync may still use. Omitted, uninstall removes
   * the app entirely: every surface, the data side and the registry row.
   */
  surfaces?: readonly AppSurface[];
}

export type { AppSurface };

/**
 * The surfaces a manifest offers: the web app when it declares compute, the
 * mobile app when it declares an Android build. Drive offers neither.
 */
export function manifestSurfaces(manifest: AppManifest): AppSurface[] {
  const out: AppSurface[] = [];
  if (manifest.infraRequirements.compute.enabled) out.push("web");
  if (manifest.mobile?.android) out.push("mobile");
  return out;
}

/** `requested`, or every surface the manifest offers; throws on one it does not. */
function resolveSurfaces(
  appId: string,
  manifest: AppManifest,
  requested: readonly AppSurface[] | undefined,
): readonly AppSurface[] {
  const offered = manifestSurfaces(manifest);
  if (requested === undefined) return offered;
  for (const surface of requested) {
    if (!offered.includes(surface)) {
      throw new Error(
        surface === "web"
          ? `${appId}'s manifest declares no compute, so it has no web app to install`
          : `${appId}'s manifest declares no mobile build`,
      );
    }
  }
  return requested;
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

async function installAppInner(input: InstallInput, registry: Registry): Promise<InstallResult> {
  const { appId, manifest, zipBuffer, config } = input;
  const ir = manifest.infraRequirements;
  // Every install creates the data side: the HMAC secret when the operator's
  // machine holds one, the data role, the DDL, the `.keep` marker and the
  // registry row. The web app adds the exec role, the bundle and the compute
  // stack; the mobile app adds the Android identity and the callback.
  const surfaces = resolveSurfaces(appId, manifest, input.surfaces);
  const web = surfaces.includes("web");
  // Resolved before any step, so a mobile app on a deployment with no
  // mobile-apps client fails before it changes anything.
  const mobileCallback = surfaces.includes("mobile")
    ? mobileCallbackTarget(manifest, config)
    : null;
  const done = await registry.getCompletedSteps(appId, "install");

  const managerCreds = await roleChain([config.managerRoleArn]);

  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;
  // What the app's Lambdas actually run as. The data role above is what the
  // broker assumes into on their behalf — see createAppExecRole.
  const appExecRoleArn = `arn:aws:iam::${config.accountId}:role/${appExecRoleName(config.stackPrefix, appId)}`;

  // SSM provisioning step: mirror the local HMAC secret to a SecureString at
  // /${stackPrefix}/app-creds/${appId}. The cloud-data-server verifier reads
  // from here; the sync supervisor (locally) signs with the *local registry's*
  // hmac_secret (makeSignerFor → shared_app_registry), so SSM must hold that
  // exact value. `readLocalHmacSecret` reads it straight from the registry
  // — the single source of truth — rather than a separately-minted creds file,
  // which is how the cloud verifier used to end up on a key no local signer
  // held (todo 39: built-in Drive's registry secret was minted at LDS startup,
  // yet cloud install minted a *different* secret into SSM → every signed
  // request 401'd "Invalid signature").
  //
  // Two parties sign with the secret: the desktop's sync supervisor, on the
  // app's channel, and the cloud web app's Lambdas. The web app therefore
  // needs it, and its install fails without a local install to mirror from.
  // Without the web app the step runs only when the operator's machine holds
  // the app, because a phone-only operator may have no desktop app at all; the
  // phone signs with its attested key and never uses the secret. An operator
  // who installs the desktop app later re-runs the install, and this step
  // mirrors the secret then.
  const local = readLocalHmacSecret(appId);
  if ("missing" in local && web) throw new Error(local.missing);
  if ("secret" in local) {
    const hmacSecret = local.secret;
    // alwaysRun: reconcile SSM to the current local secret every time. A
    // completed record doesn't guarantee SSM still matches — if the local
    // secret was re-minted, a skipped mirror would leave the cloud verifier on
    // a stale key and every signed request would 401. The put is idempotent.
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
  }

  // alwaysRun: a role made by an older install keeps that install's trust and
  // inline policies until something rewrites them. createAppRole rewrites
  // both on a role that exists, so every reinstall carries the current ones.
  await runStep(
    registry,
    appId,
    "install",
    "create_iam_role",
    done,
    async () => {
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
    },
    { alwaysRun: true },
  );

  // The app's Lambda execution identity, separate from the data role above.
  // Handlers run as this: logs, their own HMAC credential, their own sibling
  // functions — no S3, no DSQL, no sts:AssumeRole. The data role keeps its
  // powers, but only the broker can reach them now.
  //
  // Only for the web app. Without it (and Starkeep Drive has none) there is
  // no Lambda to run, and a role that can read the HMAC credential existing
  // for nothing to use is surface with no purpose.
  if (web) {
    await runStep(registry, appId, "install", "create_iam_exec_role", done, async () => {
      await createAppExecRole({
        stackPrefix: config.stackPrefix,
        appId,
        accountId: config.accountId,
        permissionsBoundaryArn: config.permissionsBoundaryArn,
        foundationalPermissionsBoundaryArn: config.foundationalPermissionsBoundaryArn,
        userDataOwnerPermissionsBoundaryArn: config.userDataOwnerPermissionsBoundaryArn,
        managerCreds,
      });
    });
  }

  // alwaysRun on attach, DDL and detach: a redeploy applies the manifest's
  // schema, so a table, index, grant or label key added since the first install
  // reaches an installed app (the bytes-watermark table did not, 2026-10-15).
  // Every statement runAppInstallDdl issues is idempotent. The DDL needs the
  // temp policy, which the detach below removes at the end of every run, so the
  // three re-run together; re-running the DDL alone retries AccessDenied
  // indefinitely (plan-app-upgrade-path-2026-09-10.md).
  await runStep(
    registry,
    appId,
    "install",
    "attach_temp_install_ddl_policy",
    done,
    () => attachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
    { alwaysRun: true },
  );

  await runStep(
    registry,
    appId,
    "install",
    "run_dsql_ddl",
    done,
    async () => {
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
        ir.labelKeys,
      );
    },
    { alwaysRun: true },
  );

  await runStep(
    registry,
    appId,
    "install",
    "detach_temp_install_ddl_policy",
    done,
    () => detachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds),
    { alwaysRun: true },
  );

  // App creds: derived fresh (not persisted) — always re-assume on resume.
  // The per-app role's runtime policy (attached at createAppRole time) covers
  // the data-plane writes done by this orchestrator step (put_s3_keep_file).
  const appCreds: AwsCredentials = await roleChain([config.managerRoleArn, appRoleArn]);

  await runStep(registry, appId, "install", "put_s3_keep_file", done, () =>
    putAppKeepFile(config.stackPrefix, appId, config.filesBucket, config.region, appCreds),
  );

  let receipt: InstallReceipt | null = null;
  if (web) {
    // install-infra owns the install-time AWS-provisioning grants (bundle
    // upload + Pulumi up). Attach the per-app temp policy on install-infra,
    // run upload + compute stack as install-infra, then detach. A bundle
    // without compute would have nothing to upload it for, so the gate is
    // strictly on `compute.enabled`.
    // alwaysRun: the temp policy is detached at the end of every run (see the
    // matching detach step below), so on a resume/redeploy — where the ledger
    // already has this step "done" from the first install — a skipped attach
    // would leave install-infra with no grant, and the alwaysRun upload_bundle
    // + install_compute_stack steps below (which run under install-infra) would
    // fail with AccessDenied. Attach is idempotent (PutRolePolicy overwrites).
    await runStep(
      registry,
      appId,
      "install",
      "attach_temp_install_infra_policy",
      done,
      () =>
        attachTempInstallInfraPolicy(
          config.stackPrefix,
          appId,
          config.accountId,
          config.region,
          managerCreds,
        ),
      { alwaysRun: true },
    );

    const infraCreds: AwsCredentials = await roleChain([
      config.managerRoleArn,
      config.installInfraRoleArn,
    ]);

    if (zipBuffer) {
      // alwaysRun: a redeploy must re-upload the freshly-built bundle even
      // though the step is already "done" from the first install — otherwise
      // the Lambda keeps serving the original code and Redeploy is a no-op.
      // Idempotent: it overwrites the same apps/<appId>/latest/dist.zip key.
      await runStep(
        registry,
        appId,
        "install",
        "upload_bundle",
        done,
        () =>
          uploadAppBundle(
            config.stackPrefix,
            appId,
            config.artifactsBucket,
            zipBuffer,
            config.region,
            infraCreds,
          ),
        { alwaysRun: true },
      );
    }

    // alwaysRun: Pulumi up is the reconcile that actually pushes new code and
    // routes. Skipping it on a redeploy (because the first install recorded
    // it "done") is why Redeploy never updated the app. Idempotent: a
    // no-change up is a cheap no-op; a changed bundleHash/manifest updates the
    // Lambda code and API Gateway routes.
    await runStep(
      registry,
      appId,
      "install",
      "install_compute_stack",
      done,
      async () => {
        const bundleHash = zipBuffer
          ? createHash("sha256").update(zipBuffer).digest("base64")
          : undefined;
        const computeCtx: ComputeContext = {
          stackPrefix: config.stackPrefix,
          appId,
          appRoleArn,
          appExecRoleArn,
          apiGatewayId: config.apiGatewayId,
          apiGatewayExecutionArn: config.apiGatewayExecutionArn,
          apiGatewayUrl: config.apiGatewayUrl,
          authorizerId: config.authorizerId,
          ...(config.sessionAuthorizerId
            ? { sessionAuthorizerId: config.sessionAuthorizerId }
            : {}),
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
      },
      { alwaysRun: true },
    );

    // alwaysRun: mirror the attach above — the policy is re-attached on every
    // run, so it must be torn down on every run too (never left dangling on
    // install-infra after the install completes). Idempotent: detach tolerates
    // an already-absent policy.
    await runStep(
      registry,
      appId,
      "install",
      "detach_temp_install_infra_policy",
      done,
      () => detachTempInstallInfraPolicy(config.stackPrefix, appId, managerCreds),
      { alwaysRun: true },
    );
  }

  // alwaysRun: the read-modify-write leaves every other app's callback alone,
  // and a cloud data server reinstall keeps the list, so re-adding is cheap
  // and repairs a callback a console edit removed.
  if (mobileCallback) {
    await runStep(
      registry,
      appId,
      "install",
      "add_mobile_callback",
      done,
      () => setMobileAppCallback(mobileCallback.pool, mobileCallback.scheme, true),
      { alwaysRun: true },
    );
  }

  // alwaysRun: the row records which surfaces are installed, and an install
  // that adds a surface to an installed app must record it.
  await runStep(
    registry,
    appId,
    "install",
    "register_app",
    done,
    () => registry.registerApp(manifest, appId, surfaces),
    { alwaysRun: true },
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

async function uninstallAppInner(input: UninstallInput, registry: Registry): Promise<void> {
  const { appId, manifest, config } = input;
  const ir = manifest.infraRequirements;
  const done = await registry.getCompletedSteps(appId, "uninstall");

  const managerCreds = await roleChain([config.managerRoleArn]);
  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;

  if (input.surfaces !== undefined) {
    await removeSurfacesInner(input, input.surfaces, registry, done, managerCreds);
    return;
  }

  if (ir.compute.enabled) await removeComputeSteps(appId, config, registry, done, managerCreds);

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

  const mobileCallback = config.mobileSignIn ? mobileCallbackTarget(manifest, config) : null;
  if (mobileCallback) {
    await runStep(registry, appId, "uninstall", "remove_mobile_callback", done, () =>
      setMobileAppCallback(mobileCallback.pool, mobileCallback.scheme, false),
    );
  }

  // Takes the Android identity with the row.
  await runStep(registry, appId, "uninstall", "delete_app_registry", done, () =>
    registry.deleteAppRegistryEntry(appId),
  );

  await runStep(registry, appId, "uninstall", "delete_iam_role", done, () =>
    // The app role carries inline policies (runtime, broker-power); DeleteRole
    // fails with DeleteConflict unless they're removed first.
    deleteAppRoleWithPolicies(config.stackPrefix, appId, managerCreds),
  );

  // Unconditional, unlike the create side. An app can be uninstalled after its
  // manifest changed, and `deleteAppExecRoleWithPolicies` tolerates a role that
  // was never created — which is also what makes it safe for an app installed
  // before the split existed.
  await runStep(registry, appId, "uninstall", "delete_iam_exec_role", done, () =>
    deleteAppExecRoleWithPolicies(config.stackPrefix, appId, managerCreds),
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
 * Remove `surfaces` and keep the data side: the role, the schema, the grants,
 * the namespace, the files and the HMAC secret, which the other surface or the
 * desktop's sync may still use. The web app takes its compute stack, bundle
 * and exec role with it; the mobile app takes its callback and its Android
 * identity, so the broker refuses its keys at once.
 *
 * Not checked against the manifest, so a surface whose declaration the
 * manifest has since dropped can still be removed.
 */
async function removeSurfacesInner(
  input: UninstallInput,
  surfaces: readonly AppSurface[],
  registry: Registry,
  done: Set<string>,
  managerCreds: AwsCredentials,
): Promise<void> {
  const { appId, manifest, config } = input;
  if (surfaces.includes("web")) {
    await removeComputeSteps(appId, config, registry, done, managerCreds);
    await runStep(registry, appId, "uninstall", "delete_iam_exec_role", done, () =>
      deleteAppExecRoleWithPolicies(config.stackPrefix, appId, managerCreds),
    );
  }
  if (surfaces.includes("mobile")) {
    const mobileCallback = config.mobileSignIn ? mobileCallbackTarget(manifest, config) : null;
    if (mobileCallback) {
      await runStep(registry, appId, "uninstall", "remove_mobile_callback", done, () =>
        setMobileAppCallback(mobileCallback.pool, mobileCallback.scheme, false),
      );
    }
  }
  await runStep(registry, appId, "uninstall", "remove_surfaces", done, () =>
    registry.removeSurfaces(appId, surfaces),
  );
  // Both ledgers now describe surfaces that are gone: the install ledger
  // would skip re-creating the exec role, and the uninstall ledger would skip
  // tearing down a compute stack installed again later.
  await registry.clearSteps(appId);
}

/** Tear down the web app's compute stack and bundle, under install-infra. */
async function removeComputeSteps(
  appId: string,
  config: InstallerConfig,
  registry: Registry,
  done: Set<string>,
  managerCreds: AwsCredentials,
): Promise<void> {
  const appRoleArn = `arn:aws:iam::${config.accountId}:role/${config.stackPrefix}-app-${appId}-role`;
  // What the app's Lambdas actually run as. The data role above is what the
  // broker assumes into on their behalf — see createAppExecRole.
  const appExecRoleArn = `arn:aws:iam::${config.accountId}:role/${appExecRoleName(config.stackPrefix, appId)}`;

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
      appExecRoleArn,
      apiGatewayId: config.apiGatewayId,
      apiGatewayExecutionArn: config.apiGatewayExecutionArn,
      apiGatewayUrl: config.apiGatewayUrl,
      authorizerId: config.authorizerId,
      ...(config.sessionAuthorizerId ? { sessionAuthorizerId: config.sessionAuthorizerId } : {}),
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
 * If the app has no local registry row the supervisor can't sign for it at all,
 * and minting a secret for the cloud side would only recreate the drift. The
 * result then says why, and an install that needs the secret fails with it,
 * directing the operator to install the app locally first.
 */
function readLocalHmacSecret(appId: string): { secret: string } | { missing: string } {
  // The local-data-server stores its sqlite DB at `${STARKEEP_DIR}/data.db`
  // (server.ts). `dataDbPath()` resolves the same root, so we open the same file.
  const dbPath = dataDbPath();
  if (!existsSync(dbPath)) {
    return {
      missing:
        `Cannot mirror the HMAC secret for "${appId}" to SSM: local data store ` +
        `${dbPath} not found. Start the local-data-server and install "${appId}" ` +
        `locally before installing it in the cloud.`,
    };
  }

  // The LDS holds this DB open; we only need a single SELECT. A busy timeout
  // rides out the brief window where the LDS might hold a write lock. (We can't
  // pass `{ readOnly: true }` — this package pins @types/node 22.10, predating
  // that option — but existsSync above guarantees we won't create the file, and
  // the lookup never writes.)
  // The concrete driver, deliberately. Opening a connection is the one place
  // that cannot be driver-agnostic — RawDatabase describes what consumers may
  // use, not how a connection comes into being.
  const db = new DatabaseSync(dbPath);
  let secret: string | null;
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    secret = appRegistryRow(db, appId)?.hmacSecret ?? null;
  } finally {
    db.close();
  }
  if (!secret) {
    return {
      missing:
        `Cannot mirror the HMAC secret for "${appId}" to SSM: no ` +
        `shared_app_registry row for "${appId}". Install "${appId}" locally ` +
        `first so the secret the sync supervisor signs with is the one mirrored ` +
        `to the cloud.`,
    };
  }

  reconcileLocalCredsFile(appId, secret);
  return { secret };
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
