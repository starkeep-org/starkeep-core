import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { DAEMON_COMMANDS, REPO_ROOT, type DaemonId } from "../../../../src/lib/exec-commands";
import {
  PIDS_DIR,
  isWorkspaceDaemonId,
  metaFile,
  pidFile,
  stopById,
} from "../../../../src/lib/daemon-control";
import { findApp } from "../../../../src/lib/app-scan";

// Ask the kernel for a free TCP port by binding to port 0, then release it.
// There's a tiny race between close() and the child binding the same port,
// but it's good enough for local dev and avoids hardcoded port collisions.
function findOpenPort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolveP(port));
      } else {
        srv.close();
        rejectP(new Error("Could not determine free port"));
      }
    });
  });
}

interface LocalRunBlock {
  command: string;
  args?: string[];
  portFlag?: string;
  cwd?: string;
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { action: "start" | "stop"; id: string };
  const { action, id } = body;

  if (action === "stop") {
    // Stop tolerates unknown ids — if there's no PID file, stopById returns
    // not-running with a clear error. We don't need to gate by id namespace
    // here because the id is only meaningful as a key into our pids/ dir.
    const result = stopById(id);
    if (!result.stopped && result.error) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    return NextResponse.json({ stopped: true });
  }

  if (action === "start") {
    mkdirSync(PIDS_DIR, { recursive: true });

    if (isWorkspaceDaemonId(id)) {
      const daemon = DAEMON_COMMANDS[id as DaemonId];
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
      // Record the fixed port so the status route can use port-based liveness:
      // for pnpm-launched dev/start servers the recorded pid is pnpm's launcher,
      // which may exit once the real server takes over — a port probe is more
      // reliable than checking that pid.
      writeFileSync(
        metaFile(id),
        JSON.stringify({ pid: child.pid, logPath, ...(daemon.port ? { port: daemon.port } : {}) }),
      );
      return NextResponse.json({ pid: child.pid, logPath, ...(daemon.port ? { port: daemon.port } : {}) });
    }

    // Installed-app daemon: spawn shape comes from the app's manifest, not a
    // hand-curated map. Apps without a localRun block can be installed but
    // not started from the admin UI.
    const found = findApp(id);
    if (!found) {
      return NextResponse.json({ error: `No manifest found for app '${id}' in configured app parent dirs` }, { status: 404 });
    }
    const localRun = found.manifest.localRun as LocalRunBlock | undefined;
    if (!localRun || typeof localRun.command !== "string") {
      return NextResponse.json(
        { error: `App '${id}' has no localRun block in its manifest; cannot be started from admin-web.` },
        { status: 400 },
      );
    }
    const spawnArgs = [...(localRun.args ?? [])];
    let port: number | undefined;
    if (localRun.portFlag) {
      port = await findOpenPort();
      spawnArgs.push(localRun.portFlag, String(port));
    }
    const cwd = resolve(found.appDir, localRun.cwd ?? ".");
    const logPath = resolve(PIDS_DIR, `${id}.log`);
    const logFd = openSync(logPath, "w");
    const child = spawn(localRun.command, spawnArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd,
    });
    child.unref();
    writeFileSync(pidFile(id), String(child.pid));
    writeFileSync(
      metaFile(id),
      JSON.stringify({ pid: child.pid, logPath, ...(port ? { port } : {}) }),
    );
    return NextResponse.json({ pid: child.pid, logPath, ...(port ? { port } : {}) });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
