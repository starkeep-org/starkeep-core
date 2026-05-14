import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
const APPS_DIR = resolve(REPO_ROOT, "..", "starkeep-apps");

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { appId?: string };
  const { appId } = body;
  if (!appId) {
    return NextResponse.json({ error: "appId is required" }, { status: 400 });
  }

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

  const secretPath = resolve(APPS_DIR, appId, ".starkeep-local.json");
  if (existsSync(secretPath)) {
    unlinkSync(secretPath);
  }

  return NextResponse.json({ appId, ok: true });
}
