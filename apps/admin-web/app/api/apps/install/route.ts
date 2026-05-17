import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
const APPS_DIR = resolve(REPO_ROOT, "..", "starkeep-apps");

/**
 * Install an app locally. Body: `{ appId, approved: true }`.
 *
 * The `approved` flag is the explicit user-consent gate: admin-web's UI must
 * show the manifest's requested `sharedTypeAccess` grants and only set
 * `approved: true` after the user clicks Approve. The server re-checks the
 * flag so a forgetful UI can't write grants behind the user's back.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { appId?: string; approved?: boolean };
  const { appId, approved } = body;
  if (!appId) {
    return NextResponse.json({ error: "appId is required" }, { status: 400 });
  }
  if (approved !== true) {
    return NextResponse.json(
      { error: "Install requires explicit user approval (approved=true)" },
      { status: 400 },
    );
  }

  const manifestPath = resolve(APPS_DIR, appId, "starkeep.manifest.json");
  if (!existsSync(manifestPath)) {
    return NextResponse.json({ error: `manifest not found at ${manifestPath}` }, { status: 404 });
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;

  let installResp: Response;
  try {
    installResp = await fetch(`${LOCAL_DATA_SERVER}/admin/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
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

  if (!installResp.ok) {
    const text = await installResp.text();
    return NextResponse.json(
      { error: "Install failed", status: installResp.status, body: text },
      { status: installResp.status },
    );
  }

  const result = (await installResp.json()) as { appId: string; hmacSecret: string };

  // Persist the per-app secret next to the manifest so the app's dev server
  // can read it server-side at startup. Gitignored — never commit secrets.
  const secretPath = resolve(APPS_DIR, appId, ".starkeep-local.json");
  writeFileSync(
    secretPath,
    JSON.stringify(
      { appId: result.appId, hmacSecret: result.hmacSecret, dataServerUrl: LOCAL_DATA_SERVER },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );

  return NextResponse.json({ appId: result.appId, secretPath, ok: true });
}
