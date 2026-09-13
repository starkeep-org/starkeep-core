import { scanApps } from "../lib/app-scan";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";

interface InstalledApp {
  appId: string;
  status: string;
}

export async function GET() {
  const scanned = scanApps();

  // null means "we could not ask" — the data server was unreachable or errored.
  // That is not the same fact as "the registry has no row for this app", and
  // collapsing the two made every card read "Not installed" whenever the data
  // server was down, which is the opposite of the truth for installed apps.
  let installed: InstalledApp[] | null = null;
  try {
    const res = await fetch(`${LOCAL_DATA_SERVER}/admin/apps`);
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
    status: installedById
      ? installedById.get(s.appId)?.status ?? "not_installed"
      : "unknown",
  }));

  return Response.json({ apps, dataServerReachable: installedById !== null });
}
