/**
 * What every cloud command shares: the admin's credentials, signing in when a
 * person is there to do it, and running an installer operation as a detached
 * run under a lock.
 *
 * Cloud work runs in a child process (`run-operation`), never in the CLI's
 * own process. The child receives the admin's credentials and nothing else of
 * AWS (`installerEnv`), so the terminal's own AWS credentials cannot leak into
 * the admin lane. A closed terminal leaves the run going, and running the same
 * command again, or opening admin-web, follows it.
 */
import { installerEnv } from "@starkeep/admin-installer/aws-env";
import { exitCodeFor, type OperationErrorCode } from "@starkeep/admin-installer/operations/errors";
import {
  adminCredentials,
  SignInRequired,
  type AdminCredentials,
} from "@starkeep/operator/admin-session";
import { readConfig } from "@starkeep/operator/config";
import { acquireLock } from "@starkeep/operator/locks";
import {
  runOperationInSlot,
  SlotBusyError,
  type SlotOperation,
} from "@starkeep/operator/operation-runs";
import { listCloudApps, installerPool, type CloudApp } from "@starkeep/operator/cloud-registry";
import { CliError, EXIT_NEEDS_INPUT } from "./errors";
import type { Io } from "./io";
import { loginAdmin } from "./commands/account";

/**
 * The admin's credentials. Without a live session, a person at a terminal
 * signs in in the browser first; a run without one stops with exit code 3.
 */
export async function adminCredentialsOrSignIn(io: Io): Promise<AdminCredentials> {
  try {
    return await adminCredentials();
  } catch (err) {
    if (!(err instanceof SignInRequired)) throw err;
    if (!io.interactive()) {
      throw new CliError(
        `${err.message.replace(/\.$/, "")}. Run \`starkeep login --admin\` first.`,
        EXIT_NEEDS_INPUT,
        "NOT_SIGNED_IN",
      );
    }
    io.event({
      type: "progress",
      message: `${err.message.replace(/\.$/, "")}. Signing in as the admin first.`,
    });
    await loginAdmin(io, false);
    return adminCredentials();
  }
}

export interface CloudRun {
  name: SlotOperation;
  input: Record<string, unknown>;
  /** What the run does, such as "photos (web)". admin-web shows the same words. */
  owner: string;
  /** The lock scope: `platform` for the cloud data server and Drive, `app-<id>` for an app. */
  lock: string;
  /** The command, for the lock's holder record. */
  command: string;
}

/** Run one cloud operation to its end and return its result's data. */
export async function runCloud(io: Io, run: CloudRun): Promise<unknown> {
  const lock = acquireLock(run.lock, run.command);
  // This process may hold the lock already, as `install --local --cloud` does.
  if (!lock.ok && lock.holder.pid !== process.pid) {
    throw new CliError(
      `Another operation holds ${run.lock} (pid ${lock.holder.pid}: ${lock.holder.command}). Try again once it ends.`,
    );
  }
  try {
    const admin = await adminCredentialsOrSignIn(io);
    let outcome;
    try {
      outcome = await runOperationInSlot({
        name: run.name,
        input: run.input,
        owner: run.owner,
        env: installerEnv(admin.stsCredentials, admin.region),
        onEvent: (event) => io.event(event),
      });
    } catch (err) {
      if (err instanceof SlotBusyError) throw new CliError(err.message);
      throw err;
    }
    if (outcome.followed) {
      io.event({
        type: "progress",
        message: `Followed a ${run.owner} run that was already going.`,
      });
    }
    const { result } = outcome;
    if (result.ok) return result.data;
    const code = result.error?.code as OperationErrorCode | undefined;
    let message = result.error?.message ?? "The operation failed.";
    if (code === "CREDENTIALS_EXPIRED" || code === "NOT_SIGNED_IN") {
      message = `${message.replace(/\.$/, "")}. Run \`starkeep login --admin\`, then run the command again.`;
    }
    throw new CliError(
      `${message}\nThe whole log: ${outcome.logPath}`,
      code ? exitCodeFor(code) : 1,
      code ?? "INSTALL_FAILED",
      outcome.logPath,
    );
  } finally {
    if (lock.ok) lock.release();
  }
}

/** Whether `config.json` describes a cloud whose data server is installed. */
export function cloudInstalled(): boolean {
  const config = readConfig() ?? {};
  return typeof config.auroraEndpoint === "string" && typeof config.stackPrefix === "string";
}

/**
 * Every app installed in the cloud, compared with its folder here. Null when
 * the cloud is not set up. With `signIn: false`, also null when no admin
 * session is open, so a read-only command never opens a browser.
 */
export async function readCloudApps(
  io: Io,
  options: { signIn: boolean },
): Promise<CloudApp[] | null> {
  const config = readConfig() ?? {};
  const hostname = config.auroraEndpoint;
  const stackPrefix = config.stackPrefix;
  if (typeof hostname !== "string" || typeof stackPrefix !== "string") return null;
  let admin: AdminCredentials;
  try {
    admin = options.signIn ? await adminCredentialsOrSignIn(io) : await adminCredentials();
  } catch (err) {
    if (err instanceof SignInRequired) return null;
    throw err;
  }
  const pool = await installerPool({
    hostname,
    region: admin.region,
    stackPrefix,
    credentials: admin.stsCredentials,
  });
  try {
    return await listCloudApps(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}
