import { createConnection } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { APP_DAEMONS, DAEMON_COMMANDS, REPO_ROOT, type DaemonId } from "../../../../../src/lib/exec-commands";

interface DaemonMeta { pid: number; port: number; }

const PIDS_DIR = resolve(REPO_ROOT, ".pids");

// Daemon IDs that are managed via PID file but not in DAEMON_COMMANDS — the
// installed-app dev servers spawned by /api/exec/daemon with a per-app cwd
// and a dynamically-allocated port.
type ExternalDaemonId = keyof typeof APP_DAEMONS;
function isExternalDaemonId(id: string): id is ExternalDaemonId {
  return Object.prototype.hasOwnProperty.call(APP_DAEMONS, id);
}

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

function tryHost(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(300);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

function isPortBound(port: number): Promise<boolean> {
  return tryHost("127.0.0.1", port).then((ok) => ok || tryHost("::1", port));
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") as DaemonId | ExternalDaemonId | null;
  const isKnown = !!id && (!!DAEMON_COMMANDS[id as DaemonId] || isExternalDaemonId(id));
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

  // Only clean up if the process is actually gone. A transient "port not yet
  // bound" reading during startup must not delete the pid/meta files — the
  // child may still be spinning up and will bind shortly.
  if (!running && !isAlive(pid)) {
    unlinkSync(pf);
    if (existsSync(metaPath)) unlinkSync(metaPath);
  }

  return NextResponse.json({
    running,
    ...(running ? { pid, ...(meta?.port !== undefined ? { port: meta.port } : {}) } : {}),
  });
}
