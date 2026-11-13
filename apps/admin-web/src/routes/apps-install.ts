import { stopById } from "../lib/daemon-control";
import { readFolderManifest } from "@starkeep/admin-installer/app-discovery";
import { installLocalApp } from "@starkeep/admin-installer/local-app-install";
import { appSource, idMismatch } from "../lib/app-scan";
import { localDataServerUrlFromEnv } from "../lib/local-daemon-urls";

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
  // user saw on the card. A reinstall (the update dialog) reads the installed
  // app's pinned folder again, so the app never switches source.
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
  // A pinned folder may now hold another app. Installing it would register
  // that app and write its secret into this app's credentials file.
  if (folder.manifest.id !== appId) {
    return Response.json(
      {
        error: `App ${appId}'s folder ${sourceDir} now holds another app's manifest.`,
        details: [idMismatch(folder.manifest.id, appId)],
      },
      { status: 409 },
    );
  }
  const manifest = folder.raw;

  const result = await installLocalApp({
    manifest,
    sourceDir,
    dataServerUrl: localDataServerUrlFromEnv(),
  });
  if (!result.ok) {
    const { error, details } = result;
    return Response.json(details ? { error, details } : { error }, { status: result.status });
  }

  // A reinstall keeps the app's secret, but a running app keeps the old
  // manifest's behavior until it restarts. Stop it, so the next Start runs
  // the new manifest.
  await stopById(appId);

  return Response.json({ appId: result.appId, secretPath: result.secretPath, ok: true });
}
