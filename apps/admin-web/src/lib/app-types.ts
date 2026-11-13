// Shared types for the app-discovery / install UI surfaced on the Dashboard.
// The app list comes from /api/apps/list; membership in the local vs. cloud
// sections is derived from each app's manifest `targets` (default ["local"]).

export {
  accessLead,
  categoriesOf,
  dependencyConsent,
  grantPermissions,
  publicSharingConsent,
} from "@starkeep/admin-installer/consent-text";

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
   * The manifest the pinned folder holds now, for a "changed" app. The update
   * dialog that Start opens installs it.
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
 * Whether `next` asks for anything the consent dialog shows that `current`
 * does not — different file access, or public links — so updating an
 * installed app to it needs the user's approval again.
 */
export function consentDiffers(current: ManifestSummary, next: ManifestSummary): boolean {
  const grants = (m: ManifestSummary) => ({
    all: m.infraRequirements?.fileAccessAll === true,
    publicSharing: m.infraRequirements?.publicSharing === true,
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

/** What `GET /api/apps/:appId/dependencies` says Install will run first. */
export type DependencyPlan =
  | { kind: "run"; display: string; cwd: string }
  | { kind: "skip"; reason: string }
  | { kind: "refused"; display: string; cwd: string; reason: string };

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
 * The `code` an install route sends with a 409 when the app's folder no
 * longer holds the manifest the person approved. The card's manifest is then
 * out of date, and the same request fails again until the card re-reads it.
 */
export const MANIFEST_NOT_APPROVED = "MANIFEST_NOT_APPROVED";
