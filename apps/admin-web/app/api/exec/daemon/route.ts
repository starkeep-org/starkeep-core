import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DAEMON_COMMANDS, REPO_ROOT, type DaemonId } from "../../../../src/lib/exec-commands";

const PIDS_DIR = resolve(REPO_ROOT, ".pids");

function pidFile(id: DaemonId) {
  return resolve(PIDS_DIR, `${id}.pid`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { action: "start" | "stop"; id: DaemonId };
  const { action, id } = body;

  if (!DAEMON_COMMANDS[id]) {
    return NextResponse.json({ error: "Unknown daemon ID" }, { status: 400 });
  }

  if (action === "start") {
    const [cmd, ...args] = DAEMON_COMMANDS[id].args;
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

  if (action === "stop") {
    const pf = pidFile(id);
    if (!existsSync(pf)) {
      return NextResponse.json({ error: "Not running (no PID file)" }, { status: 404 });
    }
    const pid = parseInt(readFileSync(pf, "utf-8"), 10);
    if (isAlive(pid)) {
      process.kill(pid, "SIGTERM");
    }
    unlinkSync(pf);
    return NextResponse.json({ stopped: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
