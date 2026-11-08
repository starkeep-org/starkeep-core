import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { starkeepDir } from "@starkeep/app-client";
import { basename, join, resolve } from "node:path";
import { DEFAULT_APPS_DIR } from "./exec-commands";

const STARKEEP_DIR = starkeepDir();
const CONFIG_PATH = join(STARKEEP_DIR, "config.json");

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// App dirs come from ~/.starkeep/config.json `appParentDirs`, as configured
// (`~` unexpanded). Each entry is an app folder or a folder of apps. An
// empty/missing list is treated as "scan nothing" — the config route is
// responsible for seeding the default sibling `starkeep-apps/` dir on first
// read.
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

export interface ScannedApp {
  appId: string;
  appDir: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
}

/** A folder the scan skipped, and why. */
export interface ScanProblem {
  /** The configured directory the folder was found under, as configured. */
  configuredDir: string;
  /** The folder skipped. */
  dir: string;
  reason: string;
}

/** What one configured directory contributed. */
export interface ScannedDir {
  /** As configured, before `~` expands. */
  dir: string;
  appCount: number;
}

export interface ScanResult {
  apps: ScannedApp[];
  problems: ScanProblem[];
  dirs: ScannedDir[];
}

const MANIFEST = "starkeep.manifest.json";

/**
 * Scan every configured directory for apps.
 *
 * A configured directory that holds `starkeep.manifest.json` is itself an app;
 * any other is scanned for app subfolders. Apps are de-duped by manifest `id`,
 * and the first one found wins. Every folder the scan skips is reported with
 * its reason, so an author whose app does not appear can see why (#136): a
 * directory that does not exist or cannot be read, a manifest that is not
 * JSON, or a duplicate id. A folder with no manifest is not a problem, because
 * a parent directory holds other things too.
 */
export function scanApps(): ScanResult {
  const seen = new Map<string, string>();
  const apps: ScannedApp[] = [];
  const problems: ScanProblem[] = [];
  const dirs: ScannedDir[] = [];

  for (const configuredDir of appParentDirs()) {
    const root = resolve(expandHome(configuredDir));
    const before = apps.length;
    const problem = (dir: string, reason: string) => problems.push({ configuredDir, dir, reason });

    const addApp = (appDir: string, fallbackId: string) => {
      const manifestPath = join(appDir, MANIFEST);
      let manifest: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          problem(appDir, `${MANIFEST} is not a JSON object.`);
          return;
        }
        manifest = parsed as Record<string, unknown>;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        problem(appDir, `${MANIFEST} could not be read as JSON: ${detail}`);
        return;
      }
      const appId = typeof manifest.id === "string" ? manifest.id : fallbackId;
      const first = seen.get(appId);
      if (first) {
        problem(appDir, `Another app already uses the id "${appId}", in ${first}.`);
        return;
      }
      seen.set(appId, appDir);
      apps.push({ appId, appDir, manifestPath, manifest });
    };

    if (!existsSync(root)) {
      problem(
        root,
        root === DEFAULT_APPS_DIR
          ? "The folder does not exist. admin-web looks for a starkeep-apps checkout beside starkeep-core by default; clone it there, or change the scanned folders in Discover apps."
          : "The folder does not exist.",
      );
    } else if (existsSync(join(root, MANIFEST))) {
      addApp(root, basename(root));
    } else {
      let names: string[] = [];
      try {
        names = readdirSync(root);
      } catch (err) {
        problem(root, `The folder could not be read: ${err instanceof Error ? err.message : err}`);
      }
      for (const name of names) {
        const appDir = resolve(root, name);
        try {
          if (!statSync(appDir).isDirectory()) continue;
        } catch {
          // A dangling link or a vanished entry is not an app folder.
          continue;
        }
        if (existsSync(join(appDir, MANIFEST))) addApp(appDir, name);
      }
    }
    dirs.push({ dir: configuredDir, appCount: apps.length - before });
  }
  return { apps, problems, dirs };
}

export function findApp(appId: string): ScannedApp | null {
  return scanApps().apps.find((a) => a.appId === appId) ?? null;
}
