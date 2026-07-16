import { createConnection } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  PIDS_DIR,
  adoptOrphanWorkspaceDaemon,
  isAlive,
  isWorkspaceDaemonId,
  pidFile,
} from "../../../../../src/lib/daemon-control";

interface DaemonMeta { pid: number; port: number; }

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
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const pf = pidFile(id);
  if (!existsSync(pf)) {
    // No pid file, but a workspace daemon has a fixed port we can still check:
    // an orphaned instance (pid file lost in a crash or bad stop) would
    // otherwise show as not-running, offering a Start that collides with the
    // port. Adopt it so the UI shows Running and Stop works.
    if (isWorkspaceDaemonId(id)) {
      const adopted = adoptOrphanWorkspaceDaemon(id);
      if (adopted) {
        return NextResponse.json({ running: true, pid: adopted.pid, port: adopted.port, adopted: true });
      }
    }
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
