/**
 * App discovery: find the apps in the folders an operator configured
 * (`appParentDirs` in ~/.starkeep/config.json). admin-web's app list and the
 * per-app cloud CLIs both call `scanApps`, so the Dashboard and a cloud install
 * always agree on which folder an app id names.
 *
 * The scan rule:
 *
 * - A configured folder that holds `starkeep.manifest.json` is one app. The
 *   scan does not look inside it.
 * - Any other configured folder is a container. Each direct child that holds a
 *   manifest is an app. The scan skips `node_modules` and dot-folders, and
 *   never goes deeper than one level.
 * - Each manifest is validated with `validateManifest`, the validator Install
 *   runs, so a manifest the scan offers is one Install accepts.
 * - Every skipped folder is reported with its reason. A container child with
 *   no manifest is not a problem, because containers hold other things too.
 *
 * TODO: This whole filesystem-scan discovery model needs to be replaced —
 * not extended — as part of publishing starkeep-core as a package. The
 * current shape (admin scans configured folders on their workstation for a
 * `starkeep.manifest.json`) only makes sense while every app lives in a local
 * checkout. Once external apps install from their own published packages
 * (npm, a registry, a URL, etc.), "what is the app's source dir?" stops being
 * a meaningful question — the manifest and bundle arrive via the package, not
 * via a directory scan. Rethink the discovery + resolution model end-to-end
 * when that work happens.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@starkeep/admin-manifest";

export const MANIFEST_FILE = "starkeep.manifest.json";

/**
 * The example app that ships with core. admin-web seeds it as the only
 * discovery folder in a new config, so a first run shows an app to install.
 */
// packages/admin-installer/src -> admin-installer -> packages -> starkeep-core
export const DEFAULT_APPS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "example-app",
);

/** Expand a leading `~` to the user's home folder. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export interface ScannedApp {
  appId: string;
  appDir: string;
  /** The configured folder the app was found in, as configured. */
  configuredDir: string;
  manifestPath: string;
  /** The manifest as the file holds it; it passed `validateManifest`. */
  manifest: Record<string, unknown>;
}

/** A folder the scan skipped, and why. */
export interface ScanProblem {
  /** The configured folder the skipped folder was found under, as configured. */
  configuredDir: string;
  /** The folder skipped. */
  dir: string;
  /** A complete sentence that names the skipped folder where it is not the configured one. */
  reason: string;
}

/** What one configured folder contributed. */
export interface ScannedDir {
  /** As configured, before `~` expands. */
  dir: string;
  apps: Array<{ appId: string; name: string }>;
  problems: ScanProblem[];
}

export interface ScanResult {
  /** Every app found, once each. */
  apps: ScannedApp[];
  /** Every problem, in folder order. */
  problems: ScanProblem[];
  /** The same apps and problems, grouped by configured folder. */
  dirs: ScannedDir[];
}

/**
 * Scan `configuredDirs` for apps, by the rule in this module's header.
 *
 * Apps are de-duped by manifest id, and the first one found wins. A folder
 * reached twice, for example once directly and once as a container's child,
 * is the same app and reports nothing the second time.
 */
export function scanApps(configuredDirs: string[]): ScanResult {
  const byId = new Map<string, string>();
  // Real path of each app folder already scanned, to its contribution.
  const visited = new Map<string, { appId: string; name: string } | null>();
  const apps: ScannedApp[] = [];
  const problems: ScanProblem[] = [];
  const dirs: ScannedDir[] = [];

  for (const configuredDir of configuredDirs) {
    const root = resolve(expandHome(configuredDir));
    const entry: ScannedDir = { dir: configuredDir, apps: [], problems: [] };
    dirs.push(entry);
    const problem = (dir: string, reason: string) => {
      const p = { configuredDir, dir, reason };
      entry.problems.push(p);
      problems.push(p);
    };

    const addApp = (appDir: string) => {
      const real = realpathSync(appDir);
      if (visited.has(real)) {
        const seen = visited.get(real);
        if (seen && !entry.apps.some((a) => a.appId === seen.appId)) entry.apps.push(seen);
        return;
      }
      visited.set(real, null);

      const folder = basename(appDir);
      const manifestPath = join(appDir, MANIFEST_FILE);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        problem(appDir, `Invalid manifest found for ${folder}: ${detail}`);
        return;
      }
      const validation = validateManifest(raw);
      if (!validation.valid || !validation.manifest) {
        problem(
          appDir,
          `Invalid manifest found for ${folder}: ${validation.errors[0] ?? "it does not match the manifest schema."}`,
        );
        return;
      }
      const appId = validation.manifest.id;
      const first = byId.get(appId);
      if (first) {
        problem(appDir, `${folder} uses the app id "${appId}", which ${first} already uses.`);
        return;
      }
      const found = { appId, name: validation.manifest.name };
      byId.set(appId, appDir);
      visited.set(real, found);
      entry.apps.push(found);
      apps.push({
        appId,
        appDir,
        configuredDir,
        manifestPath,
        manifest: raw as Record<string, unknown>,
      });
    };

    let isDir: boolean;
    try {
      isDir = statSync(root).isDirectory();
    } catch {
      problem(root, "The folder does not exist.");
      continue;
    }
    if (!isDir) {
      problem(root, "The path is a file, not a folder.");
      continue;
    }
    if (existsSync(join(root, MANIFEST_FILE))) {
      addApp(root);
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch (err) {
      problem(root, `The folder could not be read: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const name of names) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const appDir = join(root, name);
      try {
        if (!statSync(appDir).isDirectory()) continue;
      } catch {
        // A dangling link or a vanished entry is not an app folder.
        continue;
      }
      if (existsSync(join(appDir, MANIFEST_FILE))) addApp(appDir);
    }
  }
  return { apps, problems, dirs };
}
