import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DAEMON_COMMANDS, REPO_ROOT, type DaemonId } from "../../../../src/lib/exec-commands";

const PIDS_DIR = resolve(REPO_ROOT, ".pids");

// IDs managed outside DAEMON_COMMANDS (custom spawn, own cwd, etc.)
const EXTERNAL_DAEMON_IDS = ["photos-web", "file-browser"] as const;
type ExternalDaemonId = typeof EXTERNAL_DAEMON_IDS[number];

function pidFile(id: DaemonId | ExternalDaemonId) {
  return resolve(PIDS_DIR, `${id}.pid`);
}

function metaFile(id: DaemonId | ExternalDaemonId) {
  return resolve(PIDS_DIR, `${id}.meta.json`);
}

function isAlive(pid: number): boolean {
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

function stopById(id: DaemonId | ExternalDaemonId): { stopped: boolean; error?: string } {
  const pf = pidFile(id);
  if (existsSync(pf)) {
    const pid = parseInt(readFileSync(pf, "utf-8"), 10);
    if (isAlive(pid)) process.kill(-pid, "SIGTERM");
    unlinkSync(pf);
    const mf = metaFile(id);
    if (existsSync(mf)) unlinkSync(mf);
    return { stopped: true };
  }

  // No PID file — fall back to finding the process by port if one is configured.
  const port = !((EXTERNAL_DAEMON_IDS as readonly string[]).includes(id))
    ? DAEMON_COMMANDS[id as DaemonId]?.port
    : undefined;
  if (port) {
    const pid = pidByPort(port);
    if (pid) {
      process.kill(pid, "SIGTERM");
      return { stopped: true };
    }
  }

  return { stopped: false, error: "Not running (no PID file)" };
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { action: "start" | "stop"; id: DaemonId | ExternalDaemonId };
  const { action, id } = body;

  const isExternal = (EXTERNAL_DAEMON_IDS as readonly string[]).includes(id);
  const isKnown = isExternal || !!DAEMON_COMMANDS[id as DaemonId];

  if (!isKnown) {
    return NextResponse.json({ error: "Unknown daemon ID" }, { status: 400 });
  }

  if (action === "stop") {
    const result = stopById(id);
    if (!result.stopped && result.error) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    return NextResponse.json({ stopped: true });
  }

  if (action === "start") {
    if (isExternal) {
      return NextResponse.json({ error: "External daemons must be started via their own install route" }, { status: 400 });
    }
    const [cmd, ...args] = DAEMON_COMMANDS[id as DaemonId].args;
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      cwd: REPO_ROOT,
    });
    child.unref();
    mkdirSync(PIDS_DIR, { recursive: true });
    writeFileSync(pidFile(id), String(child.pid));
    return NextResponse.json({ pid: child.pid });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
