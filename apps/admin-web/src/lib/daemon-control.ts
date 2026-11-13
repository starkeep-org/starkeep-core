import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
import {
  enclosingWorkspace,
  type CommandResolution,
} from "@starkeep/admin-installer/approved-commands";
import { dirname, join, resolve } from "node:path";
import { DAEMON_COMMANDS, REPO_ROOT, type DaemonId } from "./exec-commands";

const STARKEEP_DIR = starkeepDir();
export const PIDS_DIR = join(STARKEEP_DIR, "pids");

// Any id not in DAEMON_COMMANDS is treated as an installed-app daemon —
// admin-web spawned it from a manifest's localRun block and recorded its pid
// + port in a meta file. The id namespace is therefore the union of fixed
// workspace daemons + scanned manifest ids.
export function isWorkspaceDaemonId(id: string): id is DaemonId {
  return Object.prototype.hasOwnProperty.call(DAEMON_COMMANDS, id);
}

export function pidFile(id: string) {
  return resolve(PIDS_DIR, `${id}.pid`);
}

export function metaFile(id: string) {
  return resolve(PIDS_DIR, `${id}.meta.json`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The process admin-web started for `id`, when its recorded pid still lives,
 * with the port it was started on. Null when admin-web has no live record.
 */
export function liveDaemon(id: string): { pid: number; port?: number } | null {
  let pid: number;
  try {
    pid = parseInt(readFileSync(pidFile(id), "utf-8"), 10);
  } catch {
    return null;
  }
  if (isNaN(pid) || !isAlive(pid)) return null;
  try {
    const { port } = JSON.parse(readFileSync(metaFile(id), "utf-8")) as { port?: number };
    return typeof port === "number" ? { pid, port } : { pid };
  } catch {
    return { pid };
  }
}

function pidByPort(port: number): number | null {
  // -sTCP:LISTEN: only the process listening on the port — a bare tcp:PORT
  // also matches client sockets (e.g. a health probe's lingering connection).
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" });
  const pid = parseInt(result.stdout?.trim(), 10);
  return isNaN(pid) ? null : pid;
}

// The process group id of a pid. We signal the whole group (-pgid) to take
// down the pnpm launcher plus its tsx/node/esbuild children in one shot.
// Detached spawns usually make the child its own group leader (pgid === pid),
// but that isn't guaranteed — the recorded pid can end up in a group led by an
// already-exited process, in which case `kill(-pid)` targets a nonexistent
// group and throws ESRCH. Looking up the real pgid avoids that.
function processGroupId(pid: number): number | null {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf-8",
  });
  const pgid = parseInt(result.stdout?.trim(), 10);
  return isNaN(pgid) ? null : pgid;
}

// We only signal processes whose command line matches a known dev-server
// shape; the kernel can recycle a recorded port onto an unrelated process and
// we must not kill that.
function processCommand(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf-8",
  });
  const out = result.stdout?.trim();
  return out ? out : null;
}

function looksLikeAppDaemon(cmd: string): boolean {
  return /(?:^|\/)(pnpm|node|next|vite|npm)(?:\b|$)/.test(cmd);
}

export interface StopResult {
  stopped: boolean;
  error?: string;
}

// Stop waits this long for a daemon to exit and free its port after SIGTERM,
// then sends SIGKILL and waits STOP_KILL_WAIT_MS more. Stop returns only after
// the wait, so a Start right after it finds the port free. Each app keeps one
// port across restarts, so a Start that raced a dying copy met its own port
// still bound and answered "port in use".
const STOP_GRACE_MS = 5_000;
const STOP_KILL_WAIT_MS = 2_000;

/** Send `sig` to a pid, or to a process group as `-pgid`. A target that is already gone is fine. */
function signal(target: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

/** Wait until `target` has no live process and nothing listens on `port`. False on timeout. */
async function exited(
  target: number,
  port: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!signal(target, 0) && (port === undefined || pidByPort(port) === null)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/** SIGTERM `target`, wait for it to exit and free `port`, and SIGKILL it if it does not. */
async function terminate(target: number, port: number | undefined): Promise<void> {
  signal(target, "SIGTERM");
  if (await exited(target, port, STOP_GRACE_MS)) return;
  signal(target, "SIGKILL");
  await exited(target, port, STOP_KILL_WAIT_MS);
}

/** The port a daemon serves on: the fixed port of a workspace daemon, or the one its meta file records. */
function recordedPort(id: string): number | undefined {
  if (isWorkspaceDaemonId(id)) return DAEMON_COMMANDS[id].port;
  const mf = metaFile(id);
  if (!existsSync(mf)) return undefined;
  try {
    return (JSON.parse(readFileSync(mf, "utf-8")) as { port?: number }).port;
  } catch {
    return undefined;
  }
}

function removeMetaFile(id: string): void {
  const mf = metaFile(id);
  if (existsSync(mf)) unlinkSync(mf);
}

export async function stopById(id: string): Promise<StopResult> {
  const pf = pidFile(id);
  const port = recordedPort(id);
  if (existsSync(pf)) {
    const pid = parseInt(readFileSync(pf, "utf-8"), 10);
    if (isAlive(pid)) {
      // Signal the process's actual group so children die with it. The
      // process (or its group) can vanish between the liveness check and the
      // signal, and a stale/mismatched pid must not turn Stop into a 500, so
      // `terminate` tolerates a target that is already gone.
      const pgid = processGroupId(pid);
      await terminate(pgid != null ? -pgid : pid, port);
      if (existsSync(pf)) unlinkSync(pf);
      removeMetaFile(id);
      return { stopped: true };
    }
    // A dead recorded pid does not mean the daemon is dead. What we record is
    // the pnpm launcher, and the local-data-server replaces itself on
    // PATCH /config with a *detached* successor in a new process group that the
    // launcher does not outlive. Reporting "stopped" here deleted the only
    // record we had and left the daemon serving while telling the operator it
    // was gone. Drop the stale pid and let the port decide instead — keeping
    // the meta file, which is where the port is recorded.
    unlinkSync(pf);
  }

  // No live PID — fall back to the recorded port (from meta) or the fixed
  // workspace-daemon port if applicable.
  if (port) {
    const pid = pidByPort(port);
    if (pid) {
      const cmd = processCommand(pid);
      if (!cmd || !looksLikeAppDaemon(cmd)) {
        return {
          stopped: false,
          error: `Port ${port} is bound by pid ${pid} (${cmd ?? "unreadable"}) which does not look like an app daemon; refusing to signal.`,
        };
      }
      await terminate(pid, port);
      removeMetaFile(id);
      return { stopped: true };
    }
  }

  // Nothing alive under either identity; clear any meta left by the stale-pid
  // path above so status doesn't keep reporting a ghost.
  removeMetaFile(id);
  return { stopped: false, error: "Not running (no live PID, nothing on its port)" };
}

export interface StartSuccess {
  ok: true;
  pid: number;
  logPath: string;
  port?: number;
  // True when start found an orphaned instance already bound to the fixed
  // port and re-recorded it instead of spawning a duplicate.
  adopted?: boolean;
}

export interface StartFailure {
  ok: false;
  error: string;
  logPath?: string;
}

export type StartOutcome = StartSuccess | StartFailure;

// How long we give a spawned daemon to bind its port before reporting the
// start as successful-but-unconfirmed. Confirmed death (pid gone, port
// unbound) fails immediately, whenever it happens inside this window.
const START_BIND_TIMEOUT_MS = 20_000;
// For daemons without a known port, all we can do is check the process
// survived its first moments.
const START_LIVENESS_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Last chunk of a daemon log, for embedding in start-failure errors.
export function readLogTail(logPath: string, maxBytes = 2_000): string {
  try {
    const buf = readFileSync(logPath);
    const text =
      buf.length > maxBytes
        ? "…" + buf.subarray(buf.length - maxBytes).toString("utf-8")
        : buf.toString("utf-8");
    return text.trim();
  } catch {
    return "";
  }
}

// If the daemon's working directory is npm-shaped (a package.json in scope)
// but some of its dependencies do not resolve, spawning it produces a cryptic
// module-resolution failure. Detect that up front and say which packages are
// missing and where to install them. Returns null when every declared
// dependency resolves or the directory isn't npm-shaped at all.
//
// Each declared dependency is looked up the way Node resolves it: in
// node_modules of the package's folder and of every ancestor. A bare
// "node_modules exists somewhere" test passed for an app copied into another
// repository's workspace without being listed there (#141): the workspace's
// own install made the folder, and the app's packages were never in it. The
// lookup reads `<name>/package.json` on disk rather than calling
// require.resolve, which fails on packages whose `exports` hide package.json.
export function missingDependencies(
  id: string,
  cwd: string,
  install?: CommandResolution,
): { missing: string[]; message: string } | null {
  let pkgDir: string | null = null;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      pkgDir = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (!pkgDir) return null;

  let declared: string[];
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // A dev run needs its build tools, so devDependencies count too.
    declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  } catch {
    return null;
  }
  const missing = declared.filter((name) => !resolvesFrom(pkgDir, name));
  if (missing.length === 0) return null;

  const shown = missing.length > 5 ? `${missing.slice(0, 5).join(", ")}, …` : missing.join(", ");
  const count = missing.length === 1 ? "1 dependency is" : `${missing.length} dependencies are`;
  // An installed app names the command Install runs; a workspace daemon
  // falls back to the same workspace lookup.
  const ws = enclosingWorkspace(pkgDir);
  const where =
    install && install.kind === "refused"
      ? `${install.reason} Run \`${install.display}\` in ${install.cwd}.`
      : install && install.kind !== "skip"
        ? `Run \`${install.display}\` in ${install.cwd}.`
        : !ws
          ? `Run \`pnpm install\` in ${pkgDir}.`
          : ws.covers
            ? `Run \`pnpm install\` in ${ws.root}.`
            : `${pkgDir} sits inside the pnpm workspace at ${ws.root}, which does not list it. Run \`pnpm install --ignore-workspace\` in ${pkgDir}.`;
  return {
    missing,
    message: `'${id}' cannot start: ${count} not installed (${shown}). ${where} Then try again.`,
  };
}

function resolvesFrom(pkgDir: string, name: string): boolean {
  for (let dir = pkgDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

// Functional probe of the environment a daemon needs: this Node must be able
// to spawn a child that reads the daemon's working directory and writes under
// ~/.starkeep. Run only after a start has already failed, to say *why*. The
// probe is packaging-agnostic; the env-var checks below it just decorate the
// message with the likely culprit (they're allowed to be incomplete).
export function diagnoseSpawnEnvironment(cwd: string): string | null {
  const notes: string[] = [];
  const probeFile = join(PIDS_DIR, ".spawn-probe");
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "const fs=require('fs');fs.accessSync(process.argv[1]);fs.writeFileSync(process.argv[2],'ok');fs.unlinkSync(process.argv[2]);",
      cwd,
      probeFile,
    ],
    { encoding: "utf-8", timeout: 5_000 },
  );
  if (probe.error || probe.status !== 0) {
    const detail = probe.error
      ? probe.error.message
      : (probe.stderr?.trim().split("\n").pop() ?? `exit code ${probe.status}`);
    notes.push(
      `Environment check failed: this Node runtime could not spawn a child process that reads ${cwd} and writes under ${PIDS_DIR} (${detail}). No daemon can start until this is fixed.`,
    );
  }
  if (process.env.SNAP) {
    notes.push(
      "Node.js is running from a Snap package (SNAP is set in the environment). Snap confinement is a known cause of silent daemon failures — install Node via nvm or a system package instead.",
    );
  }
  if (process.env.FLATPAK_ID) {
    notes.push(
      "This process is running inside a Flatpak sandbox (FLATPAK_ID is set), which restricts spawning processes and accessing files outside the sandbox.",
    );
  }
  return notes.length > 0 ? notes.join("\n") : null;
}

export interface SpawnDaemonOptions {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  port?: number;
  /** The dependency install Install runs for an installed app, for the hint when dependencies are missing. */
  install?: CommandResolution;
}

// Shared spawn path for all daemons (fixed workspace daemons and installed
// apps' localRun). Unlike a bare detached spawn, this records spawn errors and
// early exits in the log file and verifies the daemon actually came up before
// reporting success — a child that dies in its first moments (sandboxed Node,
// missing deps, port collision) produces an actionable error instead of a
// green light and an empty log.
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<StartOutcome> {
  const { id, command, args, cwd, port, install } = opts;
  mkdirSync(PIDS_DIR, { recursive: true });

  const deps = missingDependencies(id, cwd, install);
  if (deps) return { ok: false, error: deps.message };

  const logPath = resolve(PIDS_DIR, `${id}.log`);
  const logFd = openSync(logPath, "w");
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd,
  });
  // A detached child fails asynchronously (ENOENT/EACCES arrive as an 'error'
  // event) and dies silently; put both in the log so the tail below has
  // something to show.
  child.on("error", (err) => {
    try {
      appendFileSync(logPath, `\n[admin-web] failed to spawn '${command}': ${err.message}\n`);
    } catch {
      /* log no longer writable — nothing better to do */
    }
  });
  child.once("exit", (code, signal) => {
    try {
      appendFileSync(
        logPath,
        `\n[admin-web] '${command} ${args.join(" ")}' exited (code ${code}, signal ${signal})\n`,
      );
    } catch {
      /* ditto */
    }
  });
  child.unref();

  if (child.pid !== undefined) {
    writeFileSync(pidFile(id), String(child.pid));
    writeFileSync(
      metaFile(id),
      JSON.stringify({ pid: child.pid, logPath, ...(port ? { port } : {}) }),
    );
  }

  const failure = (): StartFailure => {
    // Confirmed dead: clean up so status doesn't keep reporting a ghost.
    try {
      unlinkSync(pidFile(id));
    } catch {
      /* never written */
    }
    try {
      unlinkSync(metaFile(id));
    } catch {
      /* never written */
    }
    const tail = readLogTail(logPath);
    const diagnosis = diagnoseSpawnEnvironment(cwd);
    return {
      ok: false,
      logPath,
      error: [
        `'${id}' exited during startup.`,
        tail ? `Last log output (${logPath}):\n${tail}` : `The log file (${logPath}) is empty.`,
        diagnosis,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  };

  const success = (): StartSuccess => ({
    ok: true,
    pid: child.pid!,
    logPath,
    ...(port ? { port } : {}),
  });

  if (port === undefined) {
    await sleep(START_LIVENESS_DELAY_MS);
    return child.pid !== undefined && isAlive(child.pid) ? success() : failure();
  }

  // Port known: poll until it's bound (up), the process dies unbound (failed),
  // or the window closes (assume a slow first build and report success — the
  // status route's port probe takes over from here).
  const deadline = Date.now() + START_BIND_TIMEOUT_MS;
  for (;;) {
    await sleep(500);
    if (pidByPort(port) !== null) return success();
    if (child.pid === undefined || !isAlive(child.pid)) return failure();
    if (Date.now() > deadline) return success();
  }
}

// An orphaned workspace daemon: its fixed port is bound by a daemon-looking
// process but we have no pid file for it (lost in a crash or a bad stop).
// Re-record it as ours so status shows it running and Stop works. Returns null
// when the port is free or bound by something we won't claim.
export function adoptOrphanWorkspaceDaemon(id: DaemonId): { pid: number; port: number } | null {
  const port = DAEMON_COMMANDS[id].port;
  if (!port) return null;
  const pid = pidByPort(port);
  if (!pid) return null;
  const cmd = processCommand(pid);
  if (!cmd || !looksLikeAppDaemon(cmd)) return null;
  mkdirSync(PIDS_DIR, { recursive: true });
  const logPath = resolve(PIDS_DIR, `${id}.log`);
  writeFileSync(pidFile(id), String(pid));
  writeFileSync(metaFile(id), JSON.stringify({ pid, logPath, port }));
  return { pid, port };
}

// Spawn a fixed workspace daemon (local-data-server / drive) detached, recording
// its pid + port the same way POST /api/exec/daemon does. Shared so callers that
// need to (re)start a daemon out-of-band — e.g. after a cloud install rewrites
// ~/.starkeep/config.json — go through one implementation.
export async function startWorkspaceDaemon(id: DaemonId): Promise<StartOutcome> {
  const daemon = DAEMON_COMMANDS[id];

  // Fixed port, so a collision is knowable up front: adopt an orphaned
  // instance instead of spawning a doomed duplicate, and refuse clearly when
  // the squatter isn't ours to claim.
  if (daemon.port) {
    const squatter = pidByPort(daemon.port);
    if (squatter) {
      const adopted = adoptOrphanWorkspaceDaemon(id);
      if (adopted) {
        return { ok: true, ...adopted, logPath: resolve(PIDS_DIR, `${id}.log`), adopted: true };
      }
      return {
        ok: false,
        error: `Port ${daemon.port} is already in use by pid ${squatter} (${processCommand(squatter) ?? "unreadable command"}), which does not look like a Starkeep daemon. Stop that process, then start '${id}' again.`,
      };
    }
  }

  const [cmd, ...args] = daemon.args;
  return spawnDaemon({ id, command: cmd, args, cwd: REPO_ROOT, port: daemon.port });
}

// The pid actually serving a workspace daemon, re-recording the pid file when
// what we wrote down has gone stale.
//
// The recorded pid is the pnpm launcher, which does not always name the process
// that ends up serving: the local-data-server replaces itself on PATCH /config
// with a *detached* successor in its own process group, and the launcher exits
// with the instance it started. The fixed port is the durable identity, so fall
// back to it and re-record — otherwise every caller below is reasoning about a
// process that no longer exists.
export function resolveWorkspaceDaemonPid(id: DaemonId): number | null {
  const pf = pidFile(id);
  if (existsSync(pf)) {
    const pid = parseInt(readFileSync(pf, "utf-8"), 10);
    if (!isNaN(pid) && isAlive(pid)) return pid;
  }
  return adoptOrphanWorkspaceDaemon(id)?.pid ?? null;
}

// True if the daemon is serving, by either identity. Used to decide whether a
// restart is warranted: if the daemon isn't running, a later manual start will
// read the updated config anyway, so there's nothing to restart.
export function isWorkspaceDaemonRunning(id: DaemonId): boolean {
  return resolveWorkspaceDaemonPid(id) !== null;
}

// Restart a running workspace daemon so it re-reads boot-time config (the
// local-data-server captures ~/.starkeep/config.json once at startup). No-op
// when the daemon isn't running.
export async function restartWorkspaceDaemonIfRunning(id: DaemonId): Promise<StartOutcome | null> {
  // Resolving first is what makes the stop below land: it re-records the pid of
  // a daemon that replaced itself, which the stale pid file would otherwise
  // hide — leaving the daemon serving its boot-time config forever.
  if (resolveWorkspaceDaemonPid(id) === null) return null;
  // Stop returns once the old instance has released its fixed port; otherwise
  // the start preflight would see it still bound and "adopt" the dying process.
  await stopById(id);
  return startWorkspaceDaemon(id);
}
