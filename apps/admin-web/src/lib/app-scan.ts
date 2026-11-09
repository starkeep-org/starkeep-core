import { readFileSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
import { join } from "node:path";
import {
  scanApps as scanFolders,
  type ScannedApp,
  type ScanResult,
} from "@starkeep/admin-installer/app-discovery";

export type {
  ScannedApp,
  ScanProblem,
  ScannedDir,
  ScanResult,
} from "@starkeep/admin-installer/app-discovery";

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

// App dirs come from ~/.starkeep/config.json `appParentDirs`, as configured
// (`~` unexpanded). Each entry is an app folder or a folder of apps. An
// empty/missing list is treated as "scan nothing" — the config route is
// responsible for seeding the default on first read.
export function appParentDirs(): string[] {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { appParentDirs?: unknown };
    if (Array.isArray(raw.appParentDirs)) {
      return raw.appParentDirs.filter((d): d is string => typeof d === "string" && d.length > 0);
    }
  } catch {
    // No config file or malformed — nothing to scan.
  }
  return [];
}

/** Scan the configured folders; the rule lives in admin-installer's `app-discovery`. */
export function scanApps(): ScanResult {
  return scanFolders(appParentDirs());
}

export function findApp(appId: string): ScannedApp | null {
  return scanApps().apps.find((a) => a.appId === appId) ?? null;
}
