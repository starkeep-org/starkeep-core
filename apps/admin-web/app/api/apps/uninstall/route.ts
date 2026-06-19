import { existsSync, unlinkSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { stopById } from "../../../../src/lib/daemon-control";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
const STARKEEP_DIR = starkeepDir();
const APP_CREDS_DIR = join(STARKEEP_DIR, "app-creds");

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { appId?: string };
  const { appId } = body;
  if (!appId) {
    return NextResponse.json({ error: "appId is required" }, { status: 400 });
  }

  // Stop the app's dev server before tearing down its registry row. Otherwise
  // the running process keeps calling the data-server with a secret that no
  // longer authenticates, and the operator sees a stream of 401s. Best-effort:
  // a "not running" result is fine; we only care that nothing keeps signing in
  // as this app after uninstall.
  stopById(appId);

  let resp: Response;
  try {
    resp = await fetch(`${LOCAL_DATA_SERVER}/admin/apps/${encodeURIComponent(appId)}`, {
      method: "DELETE",
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Could not reach local-data-server",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
  if (!resp.ok) {
    const text = await resp.text();
    return NextResponse.json(
      { error: "Uninstall failed", status: resp.status, body: text },
      { status: resp.status },
    );
  }

  const secretPath = join(APP_CREDS_DIR, `${appId}.json`);
  if (existsSync(secretPath)) {
    unlinkSync(secretPath);
  }

  return NextResponse.json({ appId, ok: true });
}
