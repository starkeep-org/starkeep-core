/**
 * An installer run that outlives admin-web's server process.
 *
 * ## Why detached
 *
 * admin-web's development server runs under `tsx watch`, which restarts the
 * server whenever a file it loaded changes. The cloud data server's install
 * rebuilds `@starkeep/protocol-primitives`, and admin-web loads that package's
 * `dist/`, so every such install restarted admin-web. The installer used to be
 * a child with piped output, held in module variables, and the restart took
 * the child down and forgot it. Each retry rebuilt `dist/` and killed itself
 * again. See `~/projects/starkeep/findings-admin-web-install-restart-2026-10-18.md`.
 *
 * ## How a run is kept
 *
 * Each run slot has a directory, `~/.starkeep/installs/<key>/`:
 *
 * - `id`: a random id for the run, so a reader can tell one run from the next.
 * - `pid`: the run's process id. The run is its own process group.
 * - `output.log`: everything the installer writes, stdout and stderr together.
 * - `exit`: the installer's exit code, written once it ends.
 *
 * A small `sh` wrapper runs the installer with its output appended to the log,
 * then records the exit code. Neither step needs admin-web, so a run started
 * by one admin-web process can be followed and finished by the next. The
 * credentials reach the installer through its environment only and never touch
 * the disk.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { starkeepDir } from "@starkeep/app-client";
import { isAlive } from "./daemon-control";

/** How often a follower looks for new output and for the run's end. */
const POLL_MS = 100;

/**
 * Runs `"$@"` with its output appended to `$1`, then writes the exit code to
 * `$2` through a rename, so a reader never sees half a code. The installer's
 * command and arguments arrive as separate words, so nothing in them is ever
 * parsed by the shell.
 */
const RECORD_SCRIPT = [
  'log=$1; exitf=$2; shift 2',
  '"$@" >>"$log" 2>&1',
  'code=$?',
  'printf "%s" "$code" >"$exitf.tmp" && mv "$exitf.tmp" "$exitf"',
].join("; ");

interface RunPaths {
  readonly dir: string;
  readonly id: string;
  readonly pid: string;
  readonly log: string;
  readonly exit: string;
}

function pathsFor(key: string): RunPaths {
  const dir = join(starkeepDir(), "installs", key);
  return { dir, id: join(dir, "id"), pid: join(dir, "pid"), log: join(dir, "output.log"), exit: join(dir, "exit") };
}

/** Where a run's full output is, for a caller that keeps a copy. */
export function runLogPath(key: string): string {
  return pathsFor(key).log;
}

export type RunStatus =
  /** No run has ever started in this slot. */
  | { readonly state: "none" }
  | { readonly state: "running"; readonly runId: string; readonly pid: number }
  /** The run ended. `code` is null when its process died without recording one. */
  | { readonly state: "ended"; readonly runId: string; readonly code: number | null };

function readCode(path: string): number | null {
  const text = readFileSync(path, "utf8").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function readRunId(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export function runStatus(key: string): RunStatus {
  const p = pathsFor(key);
  if (!existsSync(p.pid)) return { state: "none" };
  const runId = readRunId(p.id);
  if (existsSync(p.exit)) return { state: "ended", runId, code: readCode(p.exit) };
  const pid = Number(readFileSync(p.pid, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return { state: "running", runId, pid };
  return { state: "ended", runId, code: null };
}

/**
 * Start a run in `key`'s slot, detached from this process. The caller checks
 * {@link runStatus} first; starting over a running slot would put two
 * installers on one stack.
 *
 * Returns the wrapper's process, whose `error` event reports a spawn that
 * failed outright.
 */
export function startRun(
  key: string,
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcess {
  const p = pathsFor(key);
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  rmSync(p.exit, { force: true });
  rmSync(p.pid, { force: true });
  writeFileSync(p.id, randomBytes(8).toString("hex"), { mode: 0o600 });
  // Created here rather than by the shell's redirect, so the log is the
  // owner's alone like everything else under ~/.starkeep.
  writeFileSync(p.log, "", { mode: 0o600 });
  const child = spawn("/bin/sh", ["-c", RECORD_SCRIPT, "sh", p.log, p.exit, command, ...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (child.pid !== undefined) writeFileSync(p.pid, String(child.pid), { mode: 0o600 });
  return child;
}

export interface FollowOptions {
  /**
   * Where in the log to start: a byte offset that an earlier `onLine` reported,
   * or the log's current end.
   */
  readonly from: number | "end";
  /**
   * Each complete line, without its newline. Empty lines are skipped.
   * `offset` is the byte offset just past the line, where a later follower
   * resumes to pick up the next one.
   */
  readonly onLine: (line: string, offset: number) => void;
  /** The run ended, after every line it wrote has gone to `onLine`. */
  readonly onEnd: (code: number | null) => void;
}

/**
 * Follow a run's log until the run ends. Returns a function that stops
 * following early, for a connection that went away.
 */
export function followRun(key: string, options: FollowOptions): () => void {
  const p = pathsFor(key);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let stopped = false;

  let size = 0;
  if (existsSync(p.log)) {
    const fd = openSync(p.log, "r");
    try {
      size = fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  }
  /** The bytes read so far. */
  let offset = options.from === "end" ? size : Math.min(Math.max(0, options.from), size);
  /** Where `pending` starts in the log. */
  let lineStart = offset;

  function readNew(): void {
    if (!existsSync(p.log)) return;
    const fd = openSync(p.log, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return;
      const chunk = Buffer.alloc(size - offset);
      const read = readSync(fd, chunk, 0, chunk.length, offset);
      offset += read;
      pending += decoder.write(chunk.subarray(0, read));
    } finally {
      closeSync(fd);
    }
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      lineStart += Buffer.byteLength(line) + 1;
      if (line.length > 0) options.onLine(line, lineStart);
    }
  }

  function tick(): void {
    if (stopped) return;
    // The status first, then the read: the wrapper records the exit code only
    // after the installer's last write, so a run seen as ended has a complete
    // log.
    const status = runStatus(key);
    readNew();
    if (status.state === "running") return;
    stop();
    pending += decoder.end();
    if (pending.length > 0) {
      lineStart += Buffer.byteLength(pending);
      options.onLine(pending, lineStart);
    }
    pending = "";
    options.onEnd(status.state === "ended" ? status.code : null);
  }

  const timer = setInterval(tick, POLL_MS);
  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}
