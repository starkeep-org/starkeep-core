import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";
import { stopById } from "../../../../src/lib/daemon-control";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
const APPS_DIR = resolve(REPO_ROOT, "..", "starkeep-apps");
const STARKEEP_DATA_DIR = process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");
const APP_CREDS_DIR = join(STARKEEP_DATA_DIR, "app-creds");

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

  // Reject directory-name vs manifest-id mismatch up front. Without this the
  // installer would register the app under `manifest.id` while admin-web would
  // file the credentials under the directory `appId`, leaving the two
  // bookkeeping records pointing at different keys.
  if (manifest.id !== appId) {
    return NextResponse.json(
      {
        error: `Manifest id (${String(manifest.id)}) does not match install directory (${appId}). Rename the directory or fix the manifest before installing.`,
      },
      { status: 400 },
    );
  }

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
