import { resolve } from "node:path";
import {
  isWorkspaceDaemonId,
  liveDaemon,
  restartWorkspaceDaemonIfRunning,
  spawnDaemon,
  startWorkspaceDaemon,
  stopById,
  type StartOutcome,
} from "../lib/daemon-control";
import {
  resolveInstallCommand,
  type CommandSource,
} from "@starkeep/admin-installer/approved-commands";
import { appSource } from "../lib/app-scan";
import { appPort } from "../lib/app-ports";

interface LocalRunBlock {
  command: string;
  args?: string[];
  portFlag?: string;
  cwd?: string;
}

// Start outcomes carry either a verified success or a diagnosed failure
// (log tail + environment diagnosis); map the latter to a 500 so the UI
// shows the reason instead of a spinner that times out.
function startResponse(outcome: StartOutcome): Response {
  if (outcome.ok) return Response.json(outcome);
  return Response.json(
    { error: outcome.error, ...(outcome.logPath ? { logPath: outcome.logPath } : {}) },
    { status: 500 },
  );
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action: "start" | "stop" | "restart";
    id: string;
    /** Start only: move the app off a recorded port another program holds. */
    reassignPort?: boolean;
  };
  const { action, id } = body;

  if (action === "restart") {
    // Bounce a fixed workspace daemon so it re-reads boot-time config (the
    // local-data-server captures ~/.starkeep/config.json — notably CLOUD_URL and
    // the sync supervisor — once at startup). No-op when it isn't running: a
    // later manual start reads the updated config anyway. Only workspace daemons
    // have a fixed restart command; installed-app daemons are excluded.
    if (!isWorkspaceDaemonId(id)) {
      return Response.json(
        { error: `'${id}' is not a restartable workspace daemon` },
        { status: 400 },
      );
    }
    const result = await restartWorkspaceDaemonIfRunning(id);
    if (result === null) return Response.json({ restarted: false });
    if (!result.ok) return Response.json({ error: result.error }, { status: 500 });
    return Response.json({ restarted: true, ...result });
  }

  if (action === "stop") {
    // Stop tolerates unknown ids — if there's no PID file, stopById returns
    // not-running with a clear error. We don't need to gate by id namespace
    // here because the id is only meaningful as a key into our pids/ dir.
    const result = await stopById(id);
    if (!result.stopped && result.error) {
      return Response.json({ error: result.error }, { status: 404 });
    }
    return Response.json({ stopped: true });
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
    // not started from the admin UI. An installed app runs from the folder
    // Install pinned, with the manifest the user approved there.
    const found = await appSource(id);
    if (found.kind === "not-found") {
      return Response.json(
        { error: `No manifest found for app '${id}' in configured app parent dirs` },
        { status: 404 },
      );
    }
    if (found.kind === "pinned-missing") {
      return Response.json(
        {
          error: `'${id}' cannot start: its source folder ${found.appDir} no longer holds a starkeep.manifest.json. Restore the folder to start it. Uninstalling and installing from a new folder deletes the app's data on this machine.`,
        },
        { status: 409 },
      );
    }
    const localRun = found.manifest.localRun as LocalRunBlock | undefined;
    if (!localRun || typeof localRun.command !== "string") {
      return Response.json(
        {
          error: `App '${id}' has no localRun block in its manifest; cannot be started from admin-web.`,
        },
        { status: 400 },
      );
    }
    // A page whose status is stale, such as a second tab, can still offer
    // Start for an app admin-web runs. A second copy would overwrite the pid
    // and meta files, and Stop would lose the first copy. A reassign would
    // also retire the port the running copy serves on. The answer carries no
    // `reason`, so the UI offers no other port.
    const live = liveDaemon(id);
    if (live) {
      return Response.json(
        {
          error:
            live.port !== undefined
              ? `'${id}' is already running at http://localhost:${live.port}.`
              : `'${id}' is already running.`,
        },
        { status: 409 },
      );
    }
    const spawnArgs = [...(localRun.args ?? [])];
    let port: number | undefined;
    if (localRun.portFlag) {
      // One port until a reinstall or a reassign, so the app's browser
      // origin, and with it the app's localStorage and IndexedDB, survives
      // restarts (#135). A held port answers with its reason and port, so the
      // UI can offer to choose another port.
      const assigned = await appPort(id, found.installedAt, {
        reassign: body.reassignPort === true,
      });
      if (!assigned.ok) {
        return Response.json(
          assigned.reason === "port-in-use"
            ? { error: assigned.error, reason: assigned.reason, port: assigned.port }
            : { error: assigned.error },
          { status: 409 },
        );
      }
      port = assigned.port;
      spawnArgs.push(localRun.portFlag, String(port));
    }
    const cwd = resolve(found.appDir, localRun.cwd ?? ".");
    return startResponse(
      await spawnDaemon({
        id,
        command: localRun.command,
        args: spawnArgs,
        cwd,
        port,
        install: resolveInstallCommand(found.appDir, found.manifest as CommandSource),
      }),
    );
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}
