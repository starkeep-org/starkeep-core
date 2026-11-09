import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
import { join } from "node:path";
import { stopById } from "../lib/daemon-control";
import { readFolderManifest } from "@starkeep/admin-installer/app-discovery";
import { appSource } from "../lib/app-scan";
import { localDataServerUrlFromEnv } from "../lib/local-daemon-urls";

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
export async function POST(req: Request) {
  const body = (await req.json()) as { appId?: string; approved?: boolean };
  const { appId, approved } = body;
  if (!appId) {
    return Response.json({ error: "appId is required" }, { status: 400 });
  }
  if (approved !== true) {
    return Response.json(
      { error: "Install requires explicit user approval (approved=true)" },
      { status: 400 },
    );
  }

  // A first install reads the manifest the scan found, which is the one the
  // user saw on the card. A reinstall ("Update from folder") reads the
  // installed app's pinned folder again, so the app never switches source.
  const source = await appSource(appId);
  if (source.kind === "not-found") {
    return Response.json(
      { error: `App ${appId} not found in any configured parent dir` },
      { status: 404 },
    );
  }
  const sourceDir = source.appDir;
  const folder = readFolderManifest(sourceDir);
  if (folder.kind === "missing") {
    return Response.json(
      { error: `App ${appId}'s source folder ${sourceDir} no longer holds a manifest` },
      { status: 409 },
    );
  }
  if (folder.kind === "invalid") {
    return Response.json(
      { error: "The app's manifest failed validation.", details: [folder.error] },
      { status: 400 },
    );
  }
  const manifest = folder.raw;

  let installResp: Response;
  try {
    installResp = await fetch(`${localDataServerUrlFromEnv()}/admin/apps/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, sourceDir }),
    });
  } catch (err) {
    return Response.json(
      {
        error: "Could not reach local-data-server",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  if (!installResp.ok) {
    return Response.json(await installFailure(installResp), { status: installResp.status });
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
      {
        appId: result.appId,
        hmacSecret: result.hmacSecret,
        dataServerUrl: localDataServerUrlFromEnv(),
      },
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

  return Response.json({ appId: result.appId, secretPath, ok: true });
}

/**
 * Turn local-data-server's install refusal into `{ error, details? }`, where
 * `error` is a sentence the UI shows as is and `details` lists each manifest
 * validation error. local-data-server answers 400
 * `{ error: "ManifestValidationError", details }` or 500 `{ error, message }`.
 */
async function installFailure(resp: Response): Promise<{ error: string; details?: string[] }> {
  const text = await resp.text();
  const parsed = parseJsonObject(text);
  if (parsed?.error === "ManifestValidationError" && Array.isArray(parsed.details)) {
    return {
      error: "The app's manifest failed validation.",
      details: parsed.details.map(String),
    };
  }
  if (typeof parsed?.message === "string") {
    return { error: `Install failed: ${parsed.message}` };
  }
  const quoted = text.trim() ? `: ${text.trim().slice(0, 500)}` : "";
  return { error: `Install failed: local-data-server answered ${resp.status}${quoted}` };
}

function parseJsonObject(
  text: string,
): { error?: unknown; message?: unknown; details?: unknown } | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}
