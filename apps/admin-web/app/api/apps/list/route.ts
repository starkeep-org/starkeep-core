import { NextResponse } from "next/server";
import { scanApps } from "../../../../src/lib/app-scan";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";

interface InstalledApp {
  appId: string;
  status: string;
}

export async function GET() {
  const scanned = scanApps();

  let installed: InstalledApp[] = [];
  try {
    const res = await fetch(`${LOCAL_DATA_SERVER}/admin/apps`);
    if (res.ok) {
      const body = (await res.json()) as { apps: InstalledApp[] };
      installed = body.apps;
    }
  } catch {
    // local-data-server not running — that's fine; we'll show all apps as not_installed.
  }
  const installedById = new Map(installed.map((a) => [a.appId, a]));

  const apps = scanned.map((s) => ({
    appId: s.appId,
    manifest: s.manifest,
    sourceDir: s.appDir,
    status: installedById.get(s.appId)?.status ?? "not_installed",
  }));

  return NextResponse.json({ apps });
}
