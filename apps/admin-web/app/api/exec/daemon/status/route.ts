import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DAEMON_COMMANDS, REPO_ROOT, type DaemonId } from "../../../../../src/lib/exec-commands";

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

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") as DaemonId | null;
  if (!id || !DAEMON_COMMANDS[id]) {
    return NextResponse.json({ error: "Unknown daemon ID" }, { status: 400 });
  }

  const pf = pidFile(id);
  if (!existsSync(pf)) {
    return NextResponse.json({ running: false });
  }

  const pid = parseInt(readFileSync(pf, "utf-8"), 10);
  const running = isAlive(pid);
  if (!running) {
    unlinkSync(pf);
  }
  return NextResponse.json({ running, ...(running ? { pid } : {}) });
}
