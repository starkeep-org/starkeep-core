import { readFileSync } from "node:fs";
import { starkeepDir } from "@starkeep/app-client";
import { join } from "node:path";
import {
  readFolderManifest,
  scanApps as scanFolders,
  type ScannedApp,
  type ScanOptions,
  type ScanResult,
} from "@starkeep/admin-installer/app-discovery";
import { localDataServerUrlFromEnv } from "./local-daemon-urls";

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
export function scanApps(options: ScanOptions = {}): ScanResult {
  return scanFolders(appParentDirs(), options);
}

export function findApp(appId: string): ScannedApp | null {
  return scanApps().apps.find((a) => a.appId === appId) ?? null;
}

/** A row of the local data server's app registry, as `GET /admin/apps` answers. */
export interface RegistryApp {
  appId: string;
  status: string;
  /** The manifest the user approved at Install. */
  manifest: Record<string, unknown>;
  /**
   * The folder the app was installed from. Null for a built-in app, and for
   * an app installed before the registry pinned folders until it is
   * reinstalled; such an app resolves through the scan.
   */
  sourceDir: string | null;
}

/** The local app registry, or null when the local data server cannot be asked. */
export async function readRegistry(): Promise<RegistryApp[] | null> {
  try {
    const res = await fetch(`${localDataServerUrlFromEnv()}/admin/apps`);
    if (!res.ok) return null;
    return ((await res.json()) as { apps: RegistryApp[] }).apps;
  } catch {
    return null;
  }
}

/** The pinned folder of every installed app that has one, by app id. */
export function pinsOf(registry: RegistryApp[] | null): Map<string, string> {
  const pins = new Map<string, string>();
  for (const row of registry ?? []) if (row.sourceDir !== null) pins.set(row.appId, row.sourceDir);
  return pins;
}

/**
 * How an installed app's pinned folder compares with the manifest the user
 * approved: gone, holding a manifest that fails validation (with the error),
 * holding a different valid manifest (with that manifest), or unchanged
 * (null).
 */
export function pinnedSourceState(
  sourceDir: string,
  approved: Record<string, unknown>,
):
  | { sourceState: "missing" }
  | { sourceState: "invalid"; sourceError: string }
  | { sourceState: "changed"; folderManifest: Record<string, unknown> }
  | null {
  const folder = readFolderManifest(sourceDir);
  if (folder.kind === "missing") return { sourceState: "missing" };
  if (folder.kind === "invalid") return { sourceState: "invalid", sourceError: folder.error };
  if (JSON.stringify(folder.manifest) === JSON.stringify(approved)) return null;
  return { sourceState: "changed", folderManifest: folder.raw };
}

/** Where an app's code is: its installed pin, else the scan. */
export type AppSource =
  | { kind: "pinned"; appDir: string; manifest: Record<string, unknown> }
  | { kind: "pinned-missing"; appDir: string }
  | { kind: "scanned"; appDir: string; manifest: Record<string, unknown> }
  | { kind: "not-found" };

/**
 * The folder and approved manifest to run or deploy an app from. An installed
 * app runs from the folder Install pinned, with the manifest the user
 * approved, whatever the scan now finds. An app with no pin, or a registry
 * that cannot be read, resolves through the scan.
 */
export async function appSource(appId: string): Promise<AppSource> {
  const registry = await readRegistry();
  const row = registry?.find((r) => r.appId === appId);
  if (row?.sourceDir) {
    if (readFolderManifest(row.sourceDir).kind === "missing") {
      return { kind: "pinned-missing", appDir: row.sourceDir };
    }
    return { kind: "pinned", appDir: row.sourceDir, manifest: row.manifest };
  }
  const found = findApp(appId);
  return found
    ? { kind: "scanned", appDir: found.appDir, manifest: found.manifest }
    : { kind: "not-found" };
}
