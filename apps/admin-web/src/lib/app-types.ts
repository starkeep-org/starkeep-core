// Shared types for the app-discovery / install UI surfaced on the Dashboard.
// The app list comes from /api/apps/list; membership in the local vs. cloud
// sections is derived from each app's manifest `targets` (default ["local"]).

export type AppTarget = "local" | "cloud";

/**
 * What an operator installs of an app in the cloud, on top of the app's data
 * side: the cloud web app, or the mobile app. Mirrors admin-installer's
 * `AppSurface`, which admin-web cannot import (see apps-cloud-list.ts).
 */
export type AppSurface = "web" | "mobile";

/**
 * A folder app discovery skipped, as `/api/apps/list` reports it. Mirrors
 * admin-installer's `ScanProblem`, which browser code cannot import.
 */
export interface ScanProblem {
  /** The configured directory the folder was found under, as configured. */
  configuredDir: string;
  dir: string;
  /** A complete sentence, shown as is. */
  reason: string;
}

/** What one configured directory contributed to the app list. */
export interface ScannedDir {
  /** As configured, before `~` expands. */
  dir: string;
  apps: Array<{ appId: string; name: string }>;
  problems: ScanProblem[];
}

/** The body of `GET /api/apps/list`. */
export interface AppList {
  apps: LocalAppEntry[];
  problems: ScanProblem[];
  dirs: ScannedDir[];
}

export interface FileAccess {
  types: string[];
  access: "read" | "readwrite";
  metadataWrite?: boolean;
  rationale: string;
}

export interface ManifestSummary {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  targets?: AppTarget[];
  infraRequirements?: {
    fileAccess?: FileAccess[];
    fileAccessAll?: boolean;
    /** Present and enabled for an app with a cloud web app. */
    compute?: { enabled: boolean };
    /** The app asks to publish records to public links. */
    publicSharing?: boolean;
  };
  /** The mobile builds the app ships; see the manifest's `mobile` field. */
  mobile?: {
    android?: { package: string; callbackScheme: string };
  };
}

export interface LocalAppEntry {
  appId: string;
  manifest: ManifestSummary;
  /** The folder the app runs from: its Install pin, or the scan's find. */
  sourceDir: string;
  /**
   * The Discover apps entry the app was found under, as configured. Absent for
   * an installed app whose pinned folder no configured entry reaches.
   */
  configuredDir?: string;
  /**
   * Set for an installed app whose pinned folder no longer holds a manifest
   * ("missing"), holds one that fails validation ("invalid"), or holds a
   * valid one other than the user approved ("changed").
   */
  sourceState?: "missing" | "invalid" | "changed";
  /** Why the pinned folder's manifest fails validation, for an "invalid" app. */
  sourceError?: string;
  /**
   * The manifest the pinned folder holds now, for a "changed" app. Update
   * from folder installs it.
   */
  folderManifest?: ManifestSummary;
  /**
   * True for core's example app found through the folder a new config seeds.
   * Its card offers Hide, which removes that folder from Discover apps.
   */
  bundledExample?: boolean;
  // "unknown" means the install registry could not be read — the local data
  // server was down when the list was built. It is distinct from
  // "not_installed", which is a registry answer.
  status: "active" | "installing" | "uninstalling" | "not_installed" | "unknown";
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  // Reported when the status probe found an orphaned fixed-port workspace
  // daemon and re-recorded it (see adoptOrphanWorkspaceDaemon).
  adopted?: boolean;
}

export interface InstallStep {
  operation: "install" | "uninstall";
  step: string;
  status: "pending" | "done" | "failed";
  error: string | null;
  updatedAt: string;
}

/**
 * Whether `next` asks for different file access than `current`, so updating
 * an installed app to it needs the user's approval again.
 */
export function grantsDiffer(current: ManifestSummary, next: ManifestSummary): boolean {
  const grants = (m: ManifestSummary) => ({
    all: m.infraRequirements?.fileAccessAll === true,
    fileAccess: (m.infraRequirements?.fileAccess ?? [])
      .map((f) => ({
        types: [...f.types].sort(),
        access: f.access,
        metadataWrite: f.metadataWrite === true,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  return JSON.stringify(grants(current)) !== JSON.stringify(grants(next));
}

/** Membership comes from each app's manifest `targets` (default ["local"]). */
export function targetsOf(a: LocalAppEntry): AppTarget[] {
  return a.manifest.targets ?? ["local"];
}

/**
 * The cloud surfaces an app's manifest offers, by the rule admin-installer's
 * `manifestSurfaces()` applies: compute makes a web app, an Android build a
 * mobile app.
 */
export function surfacesOf(a: LocalAppEntry): AppSurface[] {
  const out: AppSurface[] = [];
  if (a.manifest.infraRequirements?.compute?.enabled) out.push("web");
  if (a.manifest.mobile?.android) out.push("mobile");
  return out;
}

/**
 * What the install dialogs say about the public-sharing capability. One
 * sentence for both the local and the cloud install, so the person approves
 * the same words either way.
 */
export function publicSharingConsent(manifest: ManifestSummary): string | null {
  if (manifest.infraRequirements?.publicSharing !== true) return null;
  const name = manifest.name ?? manifest.id ?? "This app";
  return `${name} can publish files to public links. Anyone with a link can see what it shows, without signing in.`;
}
