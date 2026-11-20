/**
 * Install, reinstall or update Starkeep Drive, the User-Data-Owner identity
 * for all shared-record sync. Drive has no compute: the install mints its
 * role, runs its DDL and registers it. It needs the cloud data server's
 * outputs in `config.json`.
 */
import { installDrive } from "../builtin-installs";
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

export const installDriveOp: Operation<Record<string, never>, { installed: true }> = async (
  ctx,
  _input,
  emit,
) => {
  const config = loadInstallerConfig(ctx.starkeepDir);
  requireConfigFields(
    ctx.starkeepDir,
    config,
    CLOUD_DATA_SERVER_FIELDS,
    "Install the cloud data server first.",
  );
  const region = regionOf(config);
  const credentials = await ctx.adminLane(region);
  const accountId = await resolveAccountId(ctx, config, region);
  emit({
    type: "progress",
    message: deploymentBanner("Starkeep Drive install", {
      region,
      stackPrefix: config.stackPrefix,
      accountId,
    }),
  });
  const install = ctx.overrides?.installDrive ?? installDrive;
  await install(deploymentInstallerConfig(config, accountId, region), credentials);
  emit({ type: "progress", message: "Starkeep Drive install complete." });
  return { installed: true };
};
