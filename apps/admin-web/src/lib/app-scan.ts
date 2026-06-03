import "server-only";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const STARKEEP_DATA_DIR = process.env.STARKEEP_DATA_DIR ?? join(homedir(), ".starkeep");
const CONFIG_PATH = join(STARKEEP_DATA_DIR, "config.json");

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// App parent dirs come from ~/.starkeep/config.json `appParentDirs`. An
// empty/missing list is treated as "scan nothing" — the config route is
// responsible for seeding the default sibling `starkeep-apps/` dir on first
// read.
export function appParentDirs(): string[] {
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

export interface ScannedApp {
  appId: string;
  appDir: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
}

// Scan all parent dirs, return one ScannedApp per discovered manifest.
// De-duped by manifest `id` (first parent wins). Malformed manifests are
// skipped silently — they will fail validation on install.
export function scanApps(): ScannedApp[] {
  const seen = new Set<string>();
  const out: ScannedApp[] = [];
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
        if (seen.has(appId)) continue;
        seen.add(appId);
        out.push({ appId, appDir, manifestPath, manifest });
      } catch {
        // Skip malformed manifests.
      }
    }
  }
  return out;
}

export function findApp(appId: string): ScannedApp | null {
  return scanApps().find((a) => a.appId === appId) ?? null;
}
