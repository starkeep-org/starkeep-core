import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { REPO_ROOT } from "../../../../src/lib/exec-commands";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
const APPS_DIR = resolve(REPO_ROOT, "..", "starkeep-apps");

interface InstalledApp {
  appId: string;
  status: string;
}

export async function GET() {
  // 1. Scan the local checkout for apps with a manifest.
  const scanned: Array<{ appId: string; manifestPath: string; manifest: Record<string, unknown> }> = [];
  if (existsSync(APPS_DIR)) {
    for (const name of readdirSync(APPS_DIR)) {
      const appDir = resolve(APPS_DIR, name);
      if (!statSync(appDir).isDirectory()) continue;
      const manifestPath = resolve(appDir, "starkeep.manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
        const appId = typeof manifest.id === "string" ? manifest.id : name;
        scanned.push({ appId, manifestPath, manifest });
      } catch {
        // Skip malformed manifests — they'll fail validation on install anyway.
      }
    }
  }

  // 2. Ask the local-data-server which apps are currently installed.
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
    sourceDir: resolve(s.manifestPath, ".."),
    status: installedById.get(s.appId)?.status ?? "not_installed",
  }));

  return NextResponse.json({ apps });
}
