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
 *   runs, so a manifest the scan offers is one Install accepts. The
 *   protocol check runs first, so an app that needs a newer platform is
 *   reported as that, not as the validation errors it also has.
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
import { validateManifest, type AppManifest } from "@starkeep/admin-manifest";
import { PROTOCOL_VERSION } from "@starkeep/protocol-primitives";
import { protocolRefusal, rawAppId } from "./protocol-check";

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

/** What a folder's `starkeep.manifest.json` holds. */
export type FolderManifest =
  | { kind: "valid"; raw: Record<string, unknown>; manifest: AppManifest }
  | { kind: "missing" }
  | { kind: "invalid"; error: string };

/** Read and validate the manifest in `dir`, with the validator Install runs. */
export function readFolderManifest(dir: string): FolderManifest {
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { kind: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    return { kind: "invalid", error: err instanceof Error ? err.message : String(err) };
  }
  // The protocol check runs first, as in both installers: an app written for
  // a newer platform usually fails this checkout's validator too, and only the
  // version mismatch says what to do.
  const refusal = protocolRefusal({
    appId: rawAppId(raw),
    rawManifest: raw,
    platformVersion: PROTOCOL_VERSION,
    target: "checkout",
  });
  if (refusal) return { kind: "invalid", error: refusal };
  const validation = validateManifest(raw);
  if (!validation.valid || !validation.manifest) {
    return {
      kind: "invalid",
      error: validation.errors[0] ?? "it does not match the manifest schema.",
    };
  }
  return { kind: "valid", raw: raw as Record<string, unknown>, manifest: validation.manifest };
}

export interface ScanOptions {
  /**
   * The folder each locally installed app was installed from, by app id. A
   * scanned folder with a pinned id is that installed app when it is the
   * pinned folder, and a conflict when it is any other folder.
   */
  pinned?: ReadonlyMap<string, string>;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Scan `configuredDirs` for apps, by the rule in this module's header.
 *
 * An app id names one folder. When two folders hold one id, both are
 * reported and neither is offered, so folder order never picks a winner.
 * When an installed app pins the id, the pinned folder is that app and every
 * other folder with the id is reported. A folder reached twice, for example
 * once directly and once as a container's child, is the same app and reports
 * nothing the second time.
 */
export function scanApps(configuredDirs: string[], options: ScanOptions = {}): ScanResult {
  interface Candidate {
    app: ScannedApp;
    name: string;
    real: string;
    /** The entry that found the folder first, then any that reached it again. */
    entries: ScannedDir[];
  }
  // Real path of each app folder already scanned; null for an invalid one.
  const visited = new Map<string, Candidate | null>();
  const candidates: Candidate[] = [];
  const dirs: ScannedDir[] = [];

  for (const configuredDir of configuredDirs) {
    const root = resolve(expandHome(configuredDir));
    const entry: ScannedDir = { dir: configuredDir, apps: [], problems: [] };
    dirs.push(entry);
    const problem = (dir: string, reason: string) => {
      entry.problems.push({ configuredDir, dir, reason });
    };

    const addApp = (appDir: string) => {
      const real = realpathSync(appDir);
      if (visited.has(real)) {
        const seen = visited.get(real);
        if (seen && !seen.entries.includes(entry)) seen.entries.push(entry);
        return;
      }
      visited.set(real, null);

      const read = readFolderManifest(appDir);
      if (read.kind !== "valid") {
        const detail = read.kind === "invalid" ? read.error : "the manifest disappeared.";
        problem(appDir, `Invalid manifest found for ${basename(appDir)}: ${detail}`);
        return;
      }
      const candidate: Candidate = {
        app: {
          appId: read.manifest.id,
          appDir,
          configuredDir,
          manifestPath: join(appDir, MANIFEST_FILE),
          manifest: read.raw,
        },
        name: read.manifest.name,
        real,
        entries: [entry],
      };
      visited.set(real, candidate);
      candidates.push(candidate);
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

  const byId = new Map<string, Candidate[]>();
  for (const c of candidates) byId.set(c.app.appId, [...(byId.get(c.app.appId) ?? []), c]);

  const apps: ScannedApp[] = [];
  for (const c of candidates) {
    const { appId, appDir, configuredDir } = c.app;
    const folder = basename(appDir);
    const conflict = (reason: string) =>
      c.entries[0]!.problems.push({ configuredDir, dir: appDir, reason });

    const pin = options.pinned?.get(appId);
    if (pin !== undefined) {
      if (c.real !== realpathOrNull(resolve(expandHome(pin)))) {
        conflict(`${folder} uses the app id "${appId}", which is already installed from ${pin}.`);
        continue;
      }
    } else {
      const others = byId.get(appId)!.filter((o) => o !== c);
      if (others.length > 0) {
        conflict(
          `${folder} uses the app id "${appId}", which ${others.map((o) => o.app.appDir).join(", ")} also uses.`,
        );
        continue;
      }
    }
    apps.push(c.app);
    for (const e of c.entries) e.apps.push({ appId, name: c.name });
  }

  return { apps, problems: dirs.flatMap((d) => d.problems), dirs };
}
