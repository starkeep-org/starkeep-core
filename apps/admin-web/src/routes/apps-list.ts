import { resolve } from "node:path";
import { DEFAULT_APPS_DIR, expandHome } from "@starkeep/admin-installer/app-discovery";
import { scanApps } from "../lib/app-scan";
import { localDataServerUrlFromEnv } from "../lib/local-daemon-urls";

interface InstalledApp {
  appId: string;
  status: string;
}

export async function GET() {
  const { apps: scanned, problems, dirs } = scanApps();

  // null means "we could not ask" — the data server was unreachable or errored.
  // That is not the same fact as "the registry has no row for this app", and
  // collapsing the two made every card read "Not installed" whenever the data
  // server was down, which is the opposite of the truth for installed apps.
  let installed: InstalledApp[] | null = null;
  try {
    const res = await fetch(`${localDataServerUrlFromEnv()}/admin/apps`);
    if (res.ok) {
      const body = (await res.json()) as { apps: InstalledApp[] };
      installed = body.apps;
    }
  } catch {
    // local-data-server not running — leave `installed` null so the apps below
    // report an unknown status rather than a fabricated one.
  }
  const installedById = installed && new Map(installed.map((a) => [a.appId, a]));

  const apps = scanned.map((s) => ({
    appId: s.appId,
    manifest: s.manifest,
    sourceDir: s.appDir,
    status: installedById ? (installedById.get(s.appId)?.status ?? "not_installed") : "unknown",
    configuredDir: s.configuredDir,
    // The example app core ships, from the folder a new config seeds. Matched
    // by folder rather than id, because authors copy the app.
    ...(resolve(expandHome(s.configuredDir)) === DEFAULT_APPS_DIR ? { bundledExample: true } : {}),
  }));

  return Response.json({ apps, problems, dirs, dataServerReachable: installedById !== null });
}
