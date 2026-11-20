/**
 * Deleting the app data a cloud uninstall kept.
 *
 * Uninstall removes an app and keeps its `app_<appId>` schema, its Postgres
 * role and its files under `apps/<appId>/` in the files bucket. Deleting them
 * is this separate action, which `cli:delete-app-data` runs. It refuses an app
 * that is still installed, and it touches only the cloud's copy: every node
 * keeps its own.
 */

import { roleChain } from "./session";
import {
  assertCloudInstallableAppId,
  assertNotReservedAppId,
  attachTempInstallDdlPolicy,
  createAppRole,
  deleteAppRoleWithPolicies,
  detachTempInstallDdlPolicy,
} from "./iam";
import {
  countRetainedAppDataDsql,
  runAppDataDeleteDdl,
  type AppDataCountsDsql,
  type DsqlDdlOptions,
} from "./dsql-ddl";
import { deleteAppFilesObjects } from "./s3";
import type { Registry } from "./registry";
import type { InstallerConfig } from "./orchestrator";

/** Deleting cloud data refused because the app is still installed there. */
export class AppStillInstalledError extends Error {
  constructor(appId: string) {
    super(
      `${appId} is installed in the cloud. Uninstall it (starkeep uninstall ${appId} --cloud) before ` +
        "deleting its data.",
    );
    this.name = "AppStillInstalledError";
  }
}

/** Deleting cloud data refused because the cloud keeps none for the app. */
export class NoRetainedCloudDataError extends Error {
  constructor(appId: string) {
    super(`The cloud keeps no data for ${appId}.`);
    this.name = "NoRetainedCloudDataError";
  }
}

export interface DeleteAppDataCloudInput {
  appId: string;
  config: InstallerConfig;
  registry: Registry;
  /**
   * Shown the counts of what the deletion destroys. The deletion runs only
   * when this resolves true; a cancelled run changes nothing.
   */
  confirm: (counts: AppDataCountsDsql) => Promise<boolean>;
}

/**
 * Delete one app's kept cloud data: its files, then its schema and Postgres
 * role, then the kept-data record. The record goes last, so a failure
 * part-way leaves it and a rerun finishes the job.
 *
 * The files need an identity that can reach `apps/<appId>/` in the files
 * bucket, and the uninstall deleted the app's own role. So this recreates the
 * app's data role with no file grants, under the per-app permissions boundary,
 * deletes the files as that role, and deletes the role again. Every verb it
 * uses is one the install and uninstall already use.
 */
export async function deleteAppDataCloud(
  input: DeleteAppDataCloudInput,
): Promise<"deleted" | "cancelled"> {
  const { appId, config, registry } = input;
  // A built-in app's role carries a wider boundary than the one this
  // recreates, and none of them keeps app data an operator would delete.
  assertNotReservedAppId(appId);
  assertCloudInstallableAppId(appId);

  const installed = await registry.listInstalledApps();
  if (installed.some((a) => a.appId === appId)) throw new AppStillInstalledError(appId);
  const kept = await registry.listRetainedAppData();
  if (!kept.some((k) => k.appId === appId)) throw new NoRetainedCloudDataError(appId);

  const managerCreds = await roleChain([config.managerRoleArn]);
  await attachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds);
  try {
    const ddlCreds = await roleChain([config.managerRoleArn, config.installDdlRoleArn]);
    const dsqlOpts: DsqlDdlOptions = {
      hostname: config.dsqlHostname,
      region: config.region,
      stackPrefix: config.stackPrefix,
      accountId: config.accountId,
      credentials: ddlCreds,
    };

    const counts = await countRetainedAppDataDsql(dsqlOpts, appId);
    if (!counts) throw new NoRetainedCloudDataError(appId);
    if (!(await input.confirm(counts))) return "cancelled";

    const appRoleArn = await createAppRole({
      stackPrefix: config.stackPrefix,
      appId,
      accountId: config.accountId,
      permissionsBoundaryArn: config.permissionsBoundaryArn,
      foundationalPermissionsBoundaryArn: config.foundationalPermissionsBoundaryArn,
      userDataOwnerPermissionsBoundaryArn: config.userDataOwnerPermissionsBoundaryArn,
      fileAccess: [],
      fileAccessAll: false,
      brokerPower: false,
      managerCreds,
    });
    try {
      const appCreds = await roleChain([config.managerRoleArn, appRoleArn]);
      await deleteAppFilesObjects(appId, config.filesBucket, config.region, appCreds);
    } finally {
      await deleteAppRoleWithPolicies(config.stackPrefix, appId, managerCreds);
    }

    await runAppDataDeleteDdl(dsqlOpts, appId);
    return "deleted";
  } finally {
    await detachTempInstallDdlPolicy(config.stackPrefix, appId, managerCreds);
  }
}
