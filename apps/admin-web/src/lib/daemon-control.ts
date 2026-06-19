import "server-only";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
import { join, resolve } from "node:path";
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
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf-8" });
  const pid = parseInt(result.stdout?.trim(), 10);
  return isNaN(pid) ? null : pid;
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
    if (isAlive(pid)) process.kill(-pid, "SIGTERM");
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

export interface StartResult {
  pid: number | undefined;
  logPath: string;
  port?: number;
}

// Spawn a fixed workspace daemon (local-data-server / drive) detached, recording
// its pid + port the same way POST /api/exec/daemon does. Shared so callers that
// need to (re)start a daemon out-of-band — e.g. after a cloud install rewrites
// ~/.starkeep/config.json — go through one implementation.
export function startWorkspaceDaemon(id: DaemonId): StartResult {
  mkdirSync(PIDS_DIR, { recursive: true });
  const daemon = DAEMON_COMMANDS[id];
  const [cmd, ...args] = daemon.args;
  const logPath = resolve(PIDS_DIR, `${id}.log`);
  const logFd = openSync(logPath, "w");
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: REPO_ROOT,
  });
  child.unref();
  writeFileSync(pidFile(id), String(child.pid));
  writeFileSync(
    metaFile(id),
    JSON.stringify({ pid: child.pid, logPath, ...(daemon.port ? { port: daemon.port } : {}) }),
  );
  return { pid: child.pid, logPath, ...(daemon.port ? { port: daemon.port } : {}) };
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
export function restartWorkspaceDaemonIfRunning(id: DaemonId): StartResult | null {
  if (!isWorkspaceDaemonRunning(id)) return null;
  stopById(id);
  return startWorkspaceDaemon(id);
}
