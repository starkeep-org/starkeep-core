/**
 * Delete the data a cloud uninstall kept for one app: the tables in its
 * `app_<appId>` schema, its Postgres role and its files under `apps/<appId>/`.
 *
 * It refuses an app that is still installed in the cloud, and it touches only
 * the cloud's copy: every device keeps its own. It never deletes on its own:
 * the input must name the app id again in `confirm`, or, for a caller in the
 * same process with a terminal, `confirmDeletion` must approve the counts. `preview` reports the counts and
 * deletes nothing.
 */
import {
  AppStillInstalledError,
  deleteAppDataCloud,
  NoRetainedCloudDataError,
} from "../cloud-app-data";
import type { AppDataCountsDsql } from "../dsql-ddl";
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

export interface DeleteAppDataInput {
  appId: string;
  /** The app id typed back. The deletion runs only when it equals `appId`. */
  confirm?: string;
  /** Report what the deletion would remove, and remove nothing. */
  preview?: boolean;
}

export interface DeleteAppDataResult {
  appId: string;
  outcome: "deleted" | "previewed" | "cancelled";
  counts?: {
    tables: Array<{ name: string; rowCount: number }>;
    totalRows: number;
    files?: { count: number; totalBytes: number };
  };
}

/** The words that say what a deletion removes, shown before the person confirms it. */
export function deletionSummary(counts: AppDataCountsDsql): string {
  const rows = `${counts.totalRows.toLocaleString()} row${counts.totalRows === 1 ? "" : "s"}`;
  const lines = [`The cloud keeps ${counts.retained.name}'s data from an uninstall:`];
  for (const t of counts.tables) lines.push(`  ${t.name}: ${t.rowCount.toLocaleString()} rows`);
  if (counts.files) {
    lines.push(
      `  files: ${counts.files.count.toLocaleString()} (${counts.files.totalBytes.toLocaleString()} bytes)`,
    );
  }
  lines.push(
    "",
    `Deleting it removes ${rows}${counts.files ? " and the files" : ""} from the cloud, ` +
      "for every account in this deployment. Records the app shared with other apps stay.",
    "Devices that keep this app's data do not upload it again after the deletion: " +
      "each device keeps its own copy, and the cloud's copy stays partial.",
  );
  return lines.join("\n");
}

export const deleteAppDataOp: Operation<DeleteAppDataInput, DeleteAppDataResult> = async (
  ctx,
  input,
  emit,
) => {
  const { appId } = input;
  if (!appId) throw new OperationError("INVALID_INPUT", "Name the app whose data to delete.");
  if (!input.preview && input.confirm !== undefined && input.confirm !== appId) {
    throw new OperationError(
      "NOT_CONFIRMED",
      `The typed id did not match ${appId}. Nothing changed.`,
    );
  }
  const config = loadInstallerConfig(ctx.starkeepDir);
  requireConfigFields(
    ctx.starkeepDir,
    config,
    CLOUD_DATA_SERVER_FIELDS,
    "There is no cloud data server install to delete app data from.",
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
  emit({
    type: "progress",
    message: deploymentBanner(`Starkeep ${appId}: delete the app data the cloud kept`, {
      region,
      stackPrefix: config.stackPrefix,
      accountId,
    }),
  });

  let seen: AppDataCountsDsql | undefined;
  let outcome: "deleted" | "cancelled";
  try {
    outcome = await (ctx.overrides?.deleteAppDataCloud ?? deleteAppDataCloud)({
      appId,
      registry,
      config: deploymentInstallerConfig(config, accountId, region),
      confirm: async (counts) => {
        seen = counts;
        emit({ type: "progress", message: deletionSummary(counts) });
        if (input.preview) return false;
        if (input.confirm === appId) return true;
        if (ctx.overrides?.confirmDeletion) return ctx.overrides.confirmDeletion(counts);
        emit({
          type: "prompt-needed",
          reason: "confirm",
          detail: `Type ${appId} to delete its cloud data.`,
        });
        return false;
      },
    });
  } catch (err) {
    if (err instanceof AppStillInstalledError || err instanceof NoRetainedCloudDataError) {
      throw new OperationError("REFUSED", err.message);
    }
    throw err;
  } finally {
    await registry.close();
  }

  const counts = seen
    ? {
        tables: seen.tables.map((t) => ({ name: t.name, rowCount: t.rowCount })),
        totalRows: seen.totalRows,
        ...(seen.files
          ? { files: { count: seen.files.count, totalBytes: seen.files.totalBytes } }
          : {}),
      }
    : undefined;
  if (outcome === "cancelled") {
    if (input.preview) return { appId, outcome: "previewed", ...(counts ? { counts } : {}) };
    throw new OperationError(
      "NOT_CONFIRMED",
      `Deleting ${appId}'s cloud data needs its id typed back (confirm: "${appId}"). Nothing changed.`,
    );
  }
  emit({ type: "progress", message: `${appId}'s cloud data deleted.` });
  return { appId, outcome: "deleted", ...(counts ? { counts } : {}) };
};
