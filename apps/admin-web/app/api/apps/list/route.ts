import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { NextResponse } from "next/server";

const LOCAL_DATA_SERVER = process.env.STARKEEP_LOCAL_DATA_SERVER_URL ?? "http://127.0.0.1:9820";
const STARKEEP_DATA_DIR = process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");
const CONFIG_PATH = join(STARKEEP_DATA_DIR, "config.json");

interface InstalledApp {
  appId: string;
  status: string;
}

// Expand a leading "~" to the user's home dir. Other "~user" forms are left
// untouched (we only support the current user's home).
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// App parent dirs come from ~/.starkeep/config.json `appParentDirs`. The
// config route seeds this list with the default sibling `starkeep-apps/` dir
// on first read, so an empty/missing list here means the user explicitly
// cleared it — we honor that and scan nothing.
function appParentDirs(): string[] {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { appParentDirs?: unknown };
    if (Array.isArray(raw.appParentDirs)) {
      return raw.appParentDirs
        .filter((d): d is string => typeof d === "string" && d.length > 0)
        .map(expandHome);
    }
  } catch {
    // No config file or malformed — nothing to scan.
  }
  return [];
}

export async function GET() {
  // 1. Scan each configured parent dir for apps with a manifest. De-dupe by
  //    appId across dirs, first-wins (earlier dirs take precedence).
  const scanned: Array<{ appId: string; manifestPath: string; manifest: Record<string, unknown> }> = [];
  const seenIds = new Set<string>();
  for (const parentDir of appParentDirs()) {
    if (!existsSync(parentDir)) continue;
    for (const name of readdirSync(parentDir)) {
      const appDir = resolve(parentDir, name);
      if (!statSync(appDir).isDirectory()) continue;
      const manifestPath = resolve(appDir, "starkeep.manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
        const appId = typeof manifest.id === "string" ? manifest.id : name;
        if (seenIds.has(appId)) continue;
        seenIds.add(appId);
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
