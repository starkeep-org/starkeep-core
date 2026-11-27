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
  followOperation,
  RUN_SLOTS,
  runOperationInSlot,
  SlotBusyError,
  type ResultEvent,
  type SlotOperation,
} from "@starkeep/operator/operation-runs";
import { runLogPath, runStatus } from "@starkeep/operator/runs";
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
    // The message for no session at all names the sign-in command itself.
    const reason = err.message.includes("starkeep login --admin")
      ? null
      : withoutSignInAgain(err.message);
    if (!io.interactive()) {
      throw new CliError(
        reason ? `${reason}. Run \`starkeep login --admin\` first.` : err.message,
        EXIT_NEEDS_INPUT,
        "NOT_SIGNED_IN",
      );
    }
    io.event({
      type: "progress",
      message: reason
        ? `${reason}. Signing in as the admin first.`
        : "Signing in as the admin first.",
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
    // Another terminal runs the same cloud operation: follow it, as admin-web
    // does, instead of refusing.
    const slot = RUN_SLOTS[run.name];
    const current = runStatus(slot);
    if (current.state === "running" && current.owner === run.owner) {
      io.event({
        type: "progress",
        message: `Following the ${run.owner} run that another command started (pid ${lock.holder.pid}: ${lock.holder.command}).`,
      });
      const followed = await followOperation(slot, 0, (event) => io.event(event));
      return resultData(followed.result, runLogPath(slot));
    }
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
    return resultData(outcome.result, outcome.logPath);
  } finally {
    if (lock.ok) lock.release();
  }
}

/**
 * A sign-in failure's message without its closing "Sign in again." and its
 * final period, so the CLI can name the command that signs in instead.
 */
function withoutSignInAgain(message: string): string {
  return message.replace(/\s*Sign in again(, then retry)?\.$/, "").replace(/\.$/, "");
}

/** A run's result data, or the failure it reports as a CliError. */
function resultData(result: ResultEvent, logPath: string): unknown {
  if (result.ok) return result.data;
  const code = result.error?.code as OperationErrorCode | undefined;
  let message = result.error?.message ?? "The operation failed.";
  if (code === "CREDENTIALS_EXPIRED" || code === "NOT_SIGNED_IN") {
    message = `${withoutSignInAgain(message)}. Run \`starkeep login --admin\`, then run the command again.`;
  }
  throw new CliError(
    `${message}\nThe whole log: ${logPath}`,
    code ? exitCodeFor(code) : 1,
    code ?? "INSTALL_FAILED",
    logPath,
  );
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
/** How a cloud read gets the admin's credentials. */
export interface CloudReadOptions {
  /** Sign in at a terminal when no session is open. */
  signIn: boolean;
  /** Count the read as a use of the session. Defaults to true. */
  markUsed?: boolean;
}

export async function readCloudApps(io: Io, options: CloudReadOptions): Promise<CloudApp[] | null> {
  return (await readCloudAppsAs(io, options))?.apps ?? null;
}

/** {@link readCloudApps}, with the admin credentials that read them. */
export async function readCloudAppsAs(
  io: Io,
  options: CloudReadOptions,
): Promise<{ apps: CloudApp[]; admin: AdminCredentials } | null> {
  const config = readConfig() ?? {};
  const hostname = config.auroraEndpoint;
  const stackPrefix = config.stackPrefix;
  if (typeof hostname !== "string" || typeof stackPrefix !== "string") return null;
  let admin: AdminCredentials;
  try {
    admin = options.signIn
      ? await adminCredentialsOrSignIn(io)
      : await adminCredentials({ markUsed: options.markUsed });
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
    return { apps: await listCloudApps(pool, config), admin };
  } finally {
    await pool.end().catch(() => {});
  }
}
