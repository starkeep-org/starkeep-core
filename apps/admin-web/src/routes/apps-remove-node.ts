import { existsSync, unlinkSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
import { join } from "node:path";
import { stopById } from "../lib/daemon-control";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
const STARKEEP_DIR = starkeepDir();
const APP_CREDS_DIR = join(STARKEEP_DIR, "app-creds");

/**
 * POST /api/apps/remove-from-node — drop this machine's copy of an app.
 *
 * The uninstall route next door says something about the app; this one says
 * something about this machine. The cloud's rows, the other desktops' rows and
 * the handset's rows are all untouched, because dropping a syncable table
 * writes no tombstone and therefore reaches no peer. Installing the app here
 * again refills it from the cloud, which is what clearing the sync watermark
 * on the way out is for.
 *
 * Same two local side effects as an uninstall: the app's process stops, and
 * its signing secret goes. Neither is data.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { appId?: string };
  const { appId } = body;
  if (!appId) {
    return Response.json({ error: "appId is required" }, { status: 400 });
  }

  stopById(appId);

  let resp: Response;
  try {
    resp = await fetch(
      `${LOCAL_DATA_SERVER}/admin/apps/${encodeURIComponent(appId)}/node-copy`,
      { method: "DELETE" },
    );
  } catch (err) {
    return Response.json(
      {
        error: "Could not reach local-data-server",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
  if (!resp.ok) {
    const text = await resp.text();
    return Response.json(
      { error: "Remove from this node failed", status: resp.status, body: text },
      { status: resp.status },
    );
  }

  const secretPath = join(APP_CREDS_DIR, `${appId}.json`);
  if (existsSync(secretPath)) {
    unlinkSync(secretPath);
  }

  return Response.json({ appId, ok: true });
}
