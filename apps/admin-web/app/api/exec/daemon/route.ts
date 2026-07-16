import { createServer } from "node:net";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  isWorkspaceDaemonId,
  restartWorkspaceDaemonIfRunning,
  spawnDaemon,
  startWorkspaceDaemon,
  stopById,
  type StartOutcome,
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

// Start outcomes carry either a verified success or a diagnosed failure
// (log tail + environment diagnosis); map the latter to a 500 so the UI
// shows the reason instead of a spinner that times out.
function startResponse(outcome: StartOutcome): NextResponse {
  if (outcome.ok) return NextResponse.json(outcome);
  return NextResponse.json(
    { error: outcome.error, ...(outcome.logPath ? { logPath: outcome.logPath } : {}) },
    { status: 500 },
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { action: "start" | "stop" | "restart"; id: string };
  const { action, id } = body;

  if (action === "restart") {
    // Bounce a fixed workspace daemon so it re-reads boot-time config (the
    // local-data-server captures ~/.starkeep/config.json — notably CLOUD_URL and
    // the sync supervisor — once at startup). No-op when it isn't running: a
    // later manual start reads the updated config anyway. Only workspace daemons
    // have a fixed restart command; installed-app daemons are excluded.
    if (!isWorkspaceDaemonId(id)) {
      return NextResponse.json(
        { error: `'${id}' is not a restartable workspace daemon` },
        { status: 400 },
      );
    }
    const result = await restartWorkspaceDaemonIfRunning(id);
    if (result === null) return NextResponse.json({ restarted: false });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
    return NextResponse.json({ restarted: true, ...result });
  }

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
    if (isWorkspaceDaemonId(id)) {
      // Fixed-port workspace daemon: startWorkspaceDaemon preflights the port
      // (adopting an orphaned instance rather than colliding with it) and
      // verifies the spawn actually came up.
      return startResponse(await startWorkspaceDaemon(id));
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
    return startResponse(
      await spawnDaemon({ id, command: localRun.command, args: spawnArgs, cwd, port }),
    );
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
