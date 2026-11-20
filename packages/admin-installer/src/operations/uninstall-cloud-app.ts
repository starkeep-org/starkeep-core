/**
 * Uninstall an app from the cloud: compute and bundle down, grants and the
 * DSQL login mapping revoked, IAM roles and the app-creds parameter deleted,
 * registry row closed out.
 *
 * Uninstall keeps the app's data: its `app_<appId>` schema and its files under
 * `apps/<appId>/`, which a reinstall gets back. `deleteAppDataOp` deletes them.
 *
 * With `surfaces`, only those surfaces go, and the data side stays for the
 * other surface and the desktop's sync.
 */
import type { AppManifest } from "@starkeep/admin-manifest";
import { appDirFor, manifestForUninstall } from "../app-cli-config";
import { uninstallApp, type AppSurface } from "../orchestrator";
import { createDsqlRegistry } from "../registry";
import type { Operation } from "./context";
import {
  CLOUD_DATA_SERVER_FIELDS,
  deploymentBanner,
  deploymentInstallerConfig,
  loadInstallerConfig,
  regionOf,
  requireConfigFields,
  resolveAccountId,
} from "./config";
import { OperationError } from "./errors";

export interface UninstallCloudAppInput {
  appId: string;
  /** The app's folder, for a registry row that predates the stored manifest. */
  appDir?: string;
  /** The surfaces to remove. Omitted, the app goes entirely. */
  surfaces?: AppSurface[];
}

export const uninstallCloudAppOp: Operation<
  UninstallCloudAppInput,
  { appId: string; surfaces: AppSurface[] | "all" }
> = async (ctx, input, emit) => {
  const { appId } = input;
  if (!appId) throw new OperationError("INVALID_INPUT", "Name the app to uninstall.");
  for (const s of input.surfaces ?? []) {
    if (s !== "web" && s !== "mobile") {
      throw new OperationError(
        "INVALID_INPUT",
        `Unknown surface "${String(s)}": use web or mobile.`,
      );
    }
  }
  const surfaces = input.surfaces && input.surfaces.length > 0 ? input.surfaces : undefined;
  const config = loadInstallerConfig(ctx.starkeepDir);
  requireConfigFields(
    ctx.starkeepDir,
    config,
    CLOUD_DATA_SERVER_FIELDS,
    "There is no cloud data server install to uninstall apps from.",
  );
  const region = regionOf(config);
  const credentials = await ctx.adminLane(region);
  const accountId = await resolveAccountId(ctx, config, region);

  const registry = (ctx.overrides?.createDsqlRegistry ?? createDsqlRegistry)({
    hostname: config.auroraEndpoint,
    region,
    stackPrefix: config.stackPrefix,
    credentials,
  });
  let manifest: AppManifest;
  try {
    const found = await manifestForUninstall(registry, appId, () =>
      appDirFor(config, appId, input.appDir),
    );
    manifest = found.manifest;
    if (found.from === "folder") {
      emit({
        type: "progress",
        message: "The cloud registry holds no manifest for this app; using its source folder.",
      });
    }
  } catch (err) {
    throw new OperationError("MANIFEST_INVALID", err instanceof Error ? err.message : String(err));
  } finally {
    await registry.close();
  }

  emit({
    type: "progress",
    message: deploymentBanner(`Starkeep ${appId} cloud uninstall`, {
      region,
      stackPrefix: config.stackPrefix,
      accountId,
    }),
  });
  const uninstall = ctx.overrides?.uninstallApp ?? uninstallApp;
  await uninstall({
    appId,
    manifest,
    registryCredentials: credentials,
    ...(surfaces ? { surfaces } : {}),
    config: deploymentInstallerConfig(config, accountId, region),
  });
  emit({
    type: "progress",
    message: surfaces
      ? `${appId}'s ${surfaces.join(" and ")} app removed; its data stays installed.`
      : `${appId} cloud uninstall complete. Its data stays in the cloud, and reinstalling ` +
        `${appId} gets it back. To delete it: starkeep uninstall ${appId} --cloud --delete-data.`,
  });
  return { appId, surfaces: surfaces ?? "all" };
};
