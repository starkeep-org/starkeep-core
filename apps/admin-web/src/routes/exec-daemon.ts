import {
  isWorkspaceDaemonId,
  restartWorkspaceDaemonIfRunning,
  stopById,
} from "@starkeep/operator/daemons";
import { startService } from "@starkeep/operator/service-control";
import { recordWanted } from "@starkeep/operator/services";

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
    recordWanted(id, false);
    if (!result.stopped && result.error) {
      return Response.json({ error: result.error }, { status: 404 });
    }
    return Response.json({ stopped: true });
  }

  if (action === "start") {
    const outcome = await startService(id, { reassignPort: body.reassignPort === true });
    if (outcome.ok) {
      recordWanted(id, true);
      return Response.json(outcome);
    }
    const { status, ok: _ok, ...rest } = outcome;
    return Response.json(rest, { status });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}
