import { createConnection } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DAEMON_COMMANDS, REPO_ROOT, type DaemonId } from "../../../../../src/lib/exec-commands";

interface DaemonMeta { pid: number; port: number; }

const PIDS_DIR = resolve(REPO_ROOT, ".pids");

// Daemon IDs that are managed via PID file but not in DAEMON_COMMANDS
// (e.g. photos-web, which is spawned by the install route with a custom cwd).
const EXTERNAL_DAEMON_IDS = ["photos-web"] as const;
type ExternalDaemonId = typeof EXTERNAL_DAEMON_IDS[number];

function pidFile(id: DaemonId | ExternalDaemonId) {
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

function isPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(300);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") as DaemonId | ExternalDaemonId | null;
  const isKnown = id && (DAEMON_COMMANDS[id as DaemonId] || (EXTERNAL_DAEMON_IDS as readonly string[]).includes(id));
  if (!isKnown) {
    return NextResponse.json({ error: "Unknown daemon ID" }, { status: 400 });
  }

  const pf = pidFile(id);
  if (!existsSync(pf)) {
    return NextResponse.json({ running: false });
  }

  const pid = parseInt(readFileSync(pf, "utf-8"), 10);
  const metaPath = resolve(PIDS_DIR, `${id}.meta.json`);
  const meta: DaemonMeta | null = existsSync(metaPath)
    ? JSON.parse(readFileSync(metaPath, "utf-8")) as DaemonMeta
    : null;

  // For external daemons with a known port, prefer port-based liveness check —
  // the stored PID is pnpm's launcher process which may exit once Next.js takes over.
  const running = meta?.port
    ? await isPortBound(meta.port)
    : isAlive(pid);

  if (!running) {
    unlinkSync(pf);
    if (existsSync(metaPath)) unlinkSync(metaPath);
  }

  return NextResponse.json({
    running,
    ...(running ? { pid, ...(meta?.port !== undefined ? { port: meta.port } : {}) } : {}),
  });
}
