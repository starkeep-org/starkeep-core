import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { stopById } from "../../../../src/lib/daemon-control";
import { findApp } from "../../../../src/lib/app-scan";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
const STARKEEP_DIR = starkeepDir();
const APP_CREDS_DIR = join(STARKEEP_DIR, "app-creds");

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

  // Resolve the app via the same filesystem scan that discovery uses, so
  // first-party (starkeep-apps/) and third-party (any configured parent dir)
  // apps install through one path. The scan also de-dupes by manifest id, so
  // the manifest we read here is the one the user saw in the app list.
  const scanned = findApp(appId);
  if (!scanned) {
    return NextResponse.json(
      { error: `App ${appId} not found in any configured parent dir` },
      { status: 404 },
    );
  }
  const manifest = scanned.manifest;

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

  // Persist the per-app secret under the host's Starkeep data dir so apps can
  // load it without depending on their cwd and so source repos stay clean of
  // host-machine state.
  mkdirSync(APP_CREDS_DIR, { recursive: true, mode: 0o700 });
  const secretPath = join(APP_CREDS_DIR, `${appId}.json`);
  writeFileSync(
    secretPath,
    JSON.stringify(
      { appId: result.appId, hmacSecret: result.hmacSecret, dataServerUrl: LOCAL_DATA_SERVER },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  // writeFileSync's mode is only honored on file creation — a reinstall over
  // an existing 0644 file would leave the loose perms. chmod unconditionally.
  chmodSync(secretPath, 0o600);

  // If the app daemon is already running, stop it so the user restarts it and
  // picks up the (possibly rotated) HMAC secret — @starkeep/app-client caches
  // credentials per process and has no file-watch invalidation.
  stopById(appId);

  return NextResponse.json({ appId: result.appId, secretPath, ok: true });
}
