import { existsSync, unlinkSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
import { join } from "node:path";
import { stopById } from "../lib/daemon-control";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
const STARKEEP_DIR = starkeepDir();
const APP_CREDS_DIR = join(STARKEEP_DIR, "app-creds");

export async function POST(req: Request) {
  const body = (await req.json()) as { appId?: string; deleteData?: boolean };
  const { appId, deleteData = false } = body;
  if (!appId) {
    return Response.json({ error: "appId is required" }, { status: 400 });
  }

  // Stop the app's dev server before tearing down its registry row. Otherwise
  // the running process keeps calling the data-server with a secret that no
  // longer authenticates, and the operator sees a stream of 401s. Best-effort:
  // a "not running" result is fine; we only care that nothing keeps signing in
  // as this app after uninstall.
  stopById(appId);

  let resp: Response;
  try {
    // The flag rides the query string because the local-data-server's
    // uninstall is a DELETE, and a DELETE with a body is a request a proxy is
    // entitled to drop. Absent, the data stays — the caller has to ask for the
    // destructive half.
    const query = deleteData ? "?deleteData=1" : "";
    resp = await fetch(
      `${LOCAL_DATA_SERVER}/admin/apps/${encodeURIComponent(appId)}${query}`,
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
      { error: "Uninstall failed", status: resp.status, body: text },
      { status: resp.status },
    );
  }

  const secretPath = join(APP_CREDS_DIR, `${appId}.json`);
  if (existsSync(secretPath)) {
    unlinkSync(secretPath);
  }

  return Response.json({ appId, ok: true, deleteData });
}
