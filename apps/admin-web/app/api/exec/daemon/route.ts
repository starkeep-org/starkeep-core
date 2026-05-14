import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { APP_DAEMONS, DAEMON_COMMANDS, REPO_ROOT, type DaemonId } from "../../../../src/lib/exec-commands";

const PIDS_DIR = resolve(REPO_ROOT, ".pids");
const APPS_DIR = resolve(REPO_ROOT, "..", "starkeep-apps");

// External app daemons: spawned with a per-app cwd inside starkeep-apps/.
type ExternalDaemonId = keyof typeof APP_DAEMONS;
function isExternalDaemonId(id: string): id is ExternalDaemonId {
  return Object.prototype.hasOwnProperty.call(APP_DAEMONS, id);
}

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

  // No PID file — fall back to finding the process by port if one is known
  // (either a fixed port from DAEMON_COMMANDS, or the last meta we wrote for
  // an external app daemon).
  let port: number | undefined;
  if (isExternalDaemonId(id)) {
    const mf = metaFile(id);
    if (existsSync(mf)) {
      try { port = (JSON.parse(readFileSync(mf, "utf-8")) as { port?: number }).port; } catch { /* ignore */ }
    }
  } else {
    port = DAEMON_COMMANDS[id as DaemonId]?.port;
  }
  if (port) {
    const pid = pidByPort(port);
    if (pid) {
      process.kill(pid, "SIGTERM");
      const mf = metaFile(id);
      if (existsSync(mf)) unlinkSync(mf);
      return { stopped: true };
    }
  }

  return { stopped: false, error: "Not running (no PID file)" };
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { action: "start" | "stop"; id: DaemonId | ExternalDaemonId };
  const { action, id } = body;

  const isExternal = isExternalDaemonId(id);
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
    mkdirSync(PIDS_DIR, { recursive: true });

    if (isExternal) {
      const cfg = APP_DAEMONS[id];
      const port = await findOpenPort();
      const [cmd, ...args] = cfg.args(port);
      // Tee stdout+stderr to a log file so failures are debuggable. Truncate
      // on each start so the log reflects the current run.
      const logPath = resolve(PIDS_DIR, `${id}.log`);
      const logFd = openSync(logPath, "w");
      const child = spawn(cmd, args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        cwd: resolve(APPS_DIR, cfg.cwd),
      });
      child.unref();
      writeFileSync(pidFile(id), String(child.pid));
      writeFileSync(metaFile(id), JSON.stringify({ pid: child.pid, port, logPath }));
      return NextResponse.json({ pid: child.pid, port, logPath });
    }

    const [cmd, ...args] = DAEMON_COMMANDS[id as DaemonId].args;
    const logPath = resolve(PIDS_DIR, `${id}.log`);
    const logFd = openSync(logPath, "w");
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: REPO_ROOT,
    });
    child.unref();
    writeFileSync(pidFile(id), String(child.pid));
    writeFileSync(metaFile(id), JSON.stringify({ pid: child.pid, logPath }));
    return NextResponse.json({ pid: child.pid, logPath });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
