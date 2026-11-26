/**
 * `starkeep update --platform`: bring the platform up to this checkout's
 * upstream, here and in the cloud.
 *
 * 1. Pull the checkout, under the same refusal rules as an app's repository,
 *    and record the pull for `--undo`.
 * 2. Install the new dependencies and rebuild, then rerun the update in a new
 *    process, so the new code runs the remaining steps. The running CLI's
 *    files changed under it.
 * 3. Restart the local services that were running.
 * 4. Preview the bootstrap stack's update, and apply it after confirmation,
 *    with this terminal's AWS credentials. Without them, say so and go on.
 * 5. Redeploy the cloud data server when its deployed record differs from
 *    this checkout, and Drive when its manifest differs. The deploy refuses
 *    to remove commits the cloud runs, unless `--force`.
 *
 * The platform goes before the apps, because an app may need a newer
 * platform but a platform never needs a newer app.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readConfig } from "@starkeep/operator/config";
import { PLATFORM_RUN_OWNERS } from "@starkeep/operator/operation-runs";
import { platformLine, platformNeedsDeploy } from "@starkeep/operator/deployment-state";
import { repoRoot } from "@starkeep/operator/repo-root";
import { serviceStatus } from "@starkeep/operator/service-control";
import { stopById } from "@starkeep/operator/daemons";
import { cloudInstalled, runCloud } from "../cloud";
import { CliError } from "../errors";
import type { Io } from "../io";
import { displayName } from "../names";
import { readCloudState, runBootstrapUpdate, updateTarget } from "./cloud";
import { startOne } from "./services";
import type { RepoUpdate } from "../git";

/** The services that run platform code, in start order. */
const PLATFORM_DAEMONS = ["local-data-server", "drive"];

export interface PlatformScope {
  local: boolean;
  cloud: boolean;
}

export interface PlatformOptions {
  scope: PlatformScope;
  yes: boolean;
  force: boolean;
  /** The checkout moved in an earlier process of this update. */
  pulled: boolean;
}

export interface PlatformOutcome {
  restarted: string[];
  bootstrap: string;
  cloudDataServer: "redeployed" | "up to date" | "skipped";
  drive: "redeployed" | "up to date" | "skipped";
}

/**
 * Rerun this update in a new process after the pull, through the wrapper,
 * which installs first. Returns the child's exit code.
 */
export function continueAfterPull(io: Io, argv: string[], recordAt: string): number {
  io.event({
    type: "progress",
    message: "Installing the new platform code, then continuing the update with it…",
  });
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot(), "scripts", "starkeep.mjs"),
      "--install-first",
      ...argv,
      "--after-platform-pull",
    ],
    {
      cwd: io.cwd,
      stdio: "inherit",
      env: { ...process.env, STARKEEP_UPDATE_CONTINUES: recordAt },
    },
  );
  if (result.error) throw new CliError(`Could not continue the update: ${result.error.message}`);
  return result.status ?? 1;
}

/** Whether the checkout the CLI runs from is one of `moved`. */
export function platformMoved(moved: RepoUpdate[]): boolean {
  const root = repoRoot();
  return moved.some((m) => m.root === root);
}

/** Steps 3 to 5, on the code this process runs. */
export async function applyPlatform(io: Io, options: PlatformOptions): Promise<PlatformOutcome> {
  const outcome: PlatformOutcome = {
    restarted: [],
    bootstrap: "skipped",
    cloudDataServer: "skipped",
    drive: "skipped",
  };

  if (options.scope.local && options.pulled) {
    const running: string[] = [];
    for (const id of PLATFORM_DAEMONS) if ((await serviceStatus(id)).running) running.push(id);
    for (const id of [...running].reverse()) {
      io.event({ type: "progress", message: `Stopping ${displayName(id)}…` });
      await stopById(id);
    }
    for (const id of running) {
      if (!(await startOne(io, id))) {
        throw new CliError(
          `${displayName(id)} did not start on the new code. Run \`starkeep logs ${id}\`.`,
        );
      }
      outcome.restarted.push(id);
    }
    // admin-web may run under the person's own watcher, so the update leaves
    // it alone and says so.
    if ((await serviceStatus("admin-web")).running) {
      io.event({
        type: "progress",
        message:
          "admin-web keeps the old code until it restarts. Stop it and run `starkeep admin`.",
      });
    }
  }

  if (!options.scope.cloud || !readConfig()?.userPoolId) return outcome;

  // The bootstrap stack, in the owner lane.
  try {
    const result = await runBootstrapUpdate(io, {
      target: updateTarget({}),
      apply: true,
      yes: options.yes,
      allowReplacement: false,
      verbose: false,
    });
    outcome.bootstrap = result;
    if (result === "declined") {
      throw new CliError(
        "The bootstrap update was declined, so the update stopped before the cloud data server.",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/no working AWS credentials/.test(message)) throw err;
    io.warn(
      `Skipped the bootstrap stack: ${message.split(". Sign in")[0]}.\n` +
        "Run `starkeep cloud bootstrap-update --apply` with the account's AWS credentials.",
    );
  }

  if (!cloudInstalled()) return outcome;
  const state = await readCloudState(io, { signIn: true });
  if (!state) throw new CliError("Could not read the cloud. Run `starkeep login --admin`.");
  io.event({ type: "progress", message: `Cloud data server: ${platformLine(state.platform)}.` });
  if (platformNeedsDeploy(state.platform)) {
    io.event({
      type: "progress",
      message: "Redeploying the cloud data server. This takes 10 to 20 minutes.",
    });
    await runCloud(io, {
      name: "install-cloud-data-server",
      input: options.force ? { allowBackward: true } : {},
      owner: PLATFORM_RUN_OWNERS.installCloudDataServer,
      lock: "platform",
      command: "starkeep update --platform",
    });
    outcome.cloudDataServer = "redeployed";
  } else {
    outcome.cloudDataServer = "up to date";
  }
  if (state.drive === false || (state.drive === null && outcome.cloudDataServer === "redeployed")) {
    io.event({ type: "progress", message: "Redeploying Drive…" });
    await runCloud(io, {
      name: "install-drive",
      input: {},
      owner: PLATFORM_RUN_OWNERS.installDrive,
      lock: "platform",
      command: "starkeep update --platform",
    });
    outcome.drive = "redeployed";
  } else if (state.drive === true) {
    outcome.drive = "up to date";
  }
  return outcome;
}
