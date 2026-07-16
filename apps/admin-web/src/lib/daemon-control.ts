import "server-only";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
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

export function stopById(id: string): StopResult {
  const pf = pidFile(id);
  if (existsSync(pf)) {
    const pid = parseInt(readFileSync(pf, "utf-8"), 10);
    if (isAlive(pid)) {
      // Signal the process's actual group so children die with it. Guard the
      // call: the process (or its group) can vanish between the liveness check
      // and the signal, and a stale/mismatched pid must not turn Stop into a 500.
      const pgid = processGroupId(pid);
      try {
        process.kill(pgid != null ? -pgid : pid, "SIGTERM");
      } catch {
        /* already gone, or group no longer exists — nothing left to stop */
      }
    }
    unlinkSync(pf);
    const mf = metaFile(id);
    if (existsSync(mf)) unlinkSync(mf);
    return { stopped: true };
  }

  // No PID file — fall back to the recorded port (from meta) or the fixed
  // workspace-daemon port if applicable.
  let port: number | undefined;
  if (isWorkspaceDaemonId(id)) {
    port = DAEMON_COMMANDS[id].port;
  } else {
    const mf = metaFile(id);
    if (existsSync(mf)) {
      try { port = (JSON.parse(readFileSync(mf, "utf-8")) as { port?: number }).port; } catch { /* ignore */ }
    }
  }
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
      process.kill(pid, "SIGTERM");
      const mf = metaFile(id);
      if (existsSync(mf)) unlinkSync(mf);
      return { stopped: true };
    }
  }

  return { stopped: false, error: "Not running (no PID file)" };
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
// but dependencies were never installed, spawning it produces a cryptic
// module-resolution failure. Detect that up front and name the directory to
// run `pnpm install` in. Returns null when deps look fine or the directory
// isn't npm-shaped at all.
function missingDepsInstallDir(cwd: string): string | null {
  let pkgDir: string | null = null;
  let wsRoot: string | null = null;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (!pkgDir && existsSync(join(dir, "package.json"))) pkgDir = dir;
    if (!wsRoot && existsSync(join(dir, "pnpm-workspace.yaml"))) wsRoot = dir;
    if (dirname(dir) === dir) break;
  }
  if (!pkgDir) return null;
  if (existsSync(join(pkgDir, "node_modules"))) return null;
  if (wsRoot && existsSync(join(wsRoot, "node_modules"))) return null;
  return wsRoot ?? pkgDir;
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
      : probe.stderr?.trim().split("\n").pop() ?? `exit code ${probe.status}`;
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
}

// Shared spawn path for all daemons (fixed workspace daemons and installed
// apps' localRun). Unlike a bare detached spawn, this records spawn errors and
// early exits in the log file and verifies the daemon actually came up before
// reporting success — a child that dies in its first moments (sandboxed Node,
// missing deps, port collision) produces an actionable error instead of a
// green light and an empty log.
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<StartOutcome> {
  const { id, command, args, cwd, port } = opts;
  mkdirSync(PIDS_DIR, { recursive: true });

  const installDir = missingDepsInstallDir(cwd);
  if (installDir) {
    return {
      ok: false,
      error: `Dependencies are not installed for '${id}' — run \`pnpm install\` in ${installDir}, then try again.`,
    };
  }

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
    } catch { /* log no longer writable — nothing better to do */ }
  });
  child.once("exit", (code, signal) => {
    try {
      appendFileSync(
        logPath,
        `\n[admin-web] '${command} ${args.join(" ")}' exited (code ${code}, signal ${signal})\n`,
      );
    } catch { /* ditto */ }
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
    try { unlinkSync(pidFile(id)); } catch { /* never written */ }
    try { unlinkSync(metaFile(id)); } catch { /* never written */ }
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

// True if the daemon's recorded pid is alive. Used to decide whether a restart
// is warranted: if the daemon isn't running, a later manual start will read the
// updated config anyway, so there's nothing to restart.
export function isWorkspaceDaemonRunning(id: DaemonId): boolean {
  const pf = pidFile(id);
  if (!existsSync(pf)) return false;
  const pid = parseInt(readFileSync(pf, "utf-8"), 10);
  return !isNaN(pid) && isAlive(pid);
}

// Restart a running workspace daemon so it re-reads boot-time config (the
// local-data-server captures ~/.starkeep/config.json once at startup). No-op
// when the daemon isn't running.
export async function restartWorkspaceDaemonIfRunning(id: DaemonId): Promise<StartOutcome | null> {
  if (!isWorkspaceDaemonRunning(id)) return null;
  stopById(id);
  // Wait for the old instance to release its fixed port; otherwise the start
  // preflight would see it still bound and "adopt" the dying process.
  const port = DAEMON_COMMANDS[id].port;
  if (port) {
    const deadline = Date.now() + 5_000;
    while (pidByPort(port) !== null && Date.now() < deadline) await sleep(200);
  }
  return startWorkspaceDaemon(id);
}
