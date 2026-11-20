/**
 * Installer operations as detached runs, for admin-web and the CLI alike.
 *
 * An operation runs in a child process (`run-operation` in
 * `@starkeep/admin-installer`), detached through `runs.ts`, with the admin's
 * credentials in its environment and nowhere else. A closed terminal or an
 * admin-web restart leaves it running, and either tool can follow it.
 *
 * Each kind of operation has a run slot, and both tools use the same slots:
 * a second start on a busy slot follows the run that holds it when it does
 * the same thing, and is refused when it does something else.
 */
import type { OperationEvent } from "./events";
import { parseEventLine } from "./events";
import { followRun, runLogPath, runStatus, startRun } from "./runs";
import { repoRoot } from "./repo-root";

/** The command that runs operation `name` with `input`. */
export function operationCommand(
  name: string,
  input: Record<string, unknown>,
): { command: string; args: string[] } {
  return {
    command: "pnpm",
    args: [
      "--filter",
      "@starkeep/admin-installer",
      "--silent",
      "run-operation",
      name,
      JSON.stringify(input),
    ],
  };
}

/**
 * The run slot of each cloud operation. admin-web's install routes use the
 * same keys, so the two tools see each other's runs.
 */
export const RUN_SLOTS = {
  "install-cloud-data-server": "cloud-data-server",
  "uninstall-cloud-data-server": "cloud-data-server",
  "install-drive": "drive",
  "install-cloud-app": "app",
  "uninstall-cloud-app": "app",
  "delete-app-data": "app",
} as const;

export type SlotOperation = keyof typeof RUN_SLOTS;

/**
 * The owners of the platform runs, as admin-web's routes and the CLI both
 * name them, so each tool follows the other's run instead of refusing it.
 */
export const PLATFORM_RUN_OWNERS = {
  installCloudDataServer: "cloud data server install",
  uninstallCloudDataServer: "cloud data server uninstall",
  installDrive: "Drive install",
} as const;

export type ResultEvent = Extract<OperationEvent, { type: "result" }>;

export interface OperationRunOutcome {
  /** The run's `result` event, or a stand-in for a run that ended without one. */
  result: ResultEvent;
  /** The run's exit code, or null when its process died without one. */
  code: number | null;
  /** The run's whole output. */
  logPath: string;
  /** Whether this call followed a run that another caller started. */
  followed: boolean;
}

export class SlotBusyError extends Error {
  constructor(
    readonly slot: string,
    readonly owner: string | null,
  ) {
    super(
      `Another cloud operation is running (${owner ?? "unknown"}). Wait for it to end, or follow it in admin-web.`,
    );
    this.name = "SlotBusyError";
  }
}

export interface StartOperationOptions {
  name: SlotOperation;
  input: Record<string, unknown>;
  /** What the run does, such as "photos (web)". A busy slot with another owner refuses. */
  owner: string;
  /** The child's whole environment: the caller passes `installerEnv(...)`. */
  env: NodeJS.ProcessEnv;
  onEvent: (event: OperationEvent) => void;
}

function outcomeOf(result: ResultEvent | null, code: number | null): ResultEvent {
  if (result) return result;
  return code === 0
    ? { type: "result", ok: true }
    : {
        type: "result",
        ok: false,
        error: { message: `The operation ended without a result (exit ${code ?? "unknown"}).` },
      };
}

/** Follow the run in `slot` from `from` to its end, handing each event to `onEvent`. */
export function followOperation(
  slot: string,
  from: number | "end",
  onEvent: (event: OperationEvent) => void,
): Promise<{ result: ResultEvent; code: number | null }> {
  let result: ResultEvent | null = null;
  return new Promise((done) => {
    followRun(slot, {
      from,
      onLine: (line) => {
        const event = parseEventLine(line);
        if (event.type === "result") result = event;
        else onEvent(event);
      },
      onEnd: (code) => done({ result: outcomeOf(result, code), code }),
    });
  });
}

/**
 * Start operation `name` in its slot and follow it to the end. When the slot
 * already runs the same thing (same owner), follow that run from its start
 * instead of starting a second one. When it runs something else, throw
 * {@link SlotBusyError}.
 */
export async function runOperationInSlot(
  options: StartOperationOptions,
): Promise<OperationRunOutcome> {
  const slot = RUN_SLOTS[options.name];
  const current = runStatus(slot);
  if (current.state === "running") {
    if (current.owner !== options.owner) throw new SlotBusyError(slot, current.owner);
    const followed = await followOperation(slot, 0, options.onEvent);
    return { ...followed, logPath: runLogPath(slot), followed: true };
  }
  const { command, args } = operationCommand(options.name, options.input);
  const child = startRun(slot, command, args, {
    cwd: repoRoot(),
    env: options.env,
    owner: options.owner,
  });
  const spawnFailed = new Promise<Error>((fail) => child.once("error", fail));
  const followed = followOperation(slot, 0, options.onEvent);
  const first = await Promise.race([followed, spawnFailed]);
  if (first instanceof Error) throw first;
  return { ...first, logPath: runLogPath(slot), followed: false };
}
