// Shared types for the app-discovery / install UI surfaced on the Dashboard.
// The app list comes from /api/apps/list; membership in the local vs. cloud
// sections is derived from each app's manifest `targets` (default ["local"]).

export type AppTarget = "local" | "cloud";

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
  };
}

export interface LocalAppEntry {
  appId: string;
  manifest: ManifestSummary;
  sourceDir: string;
  status: "active" | "installing" | "uninstalling" | "not_installed";
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

/** Membership comes from each app's manifest `targets` (default ["local"]). */
export function targetsOf(a: LocalAppEntry): AppTarget[] {
  return a.manifest.targets ?? ["local"];
}

// ---------------------------------------------------------------------------
// Uninstall preview. Served by /api/apps/[appId]/uninstall-preview, which
// proxies the local-data-server. Uninstall drops the app's own syncable
// tables and deletes its syncable files outright, so the confirmation dialog
// uses this to say what is in them before the operator agrees to lose it.
// ---------------------------------------------------------------------------

export interface UninstallPreviewTable {
  /** Manifest-declared table name, e.g. `image_enriched`. */
  name: string;
  /** Live rows; tombstoned ones are already gone and are not counted. */
  rowCount: number;
  /** Up to three one-line renderings of real rows. */
  samples: string[];
}

export interface UninstallPreviewFiles {
  count: number;
  totalBytes: number;
  samples: Array<{ name: string; sizeBytes: number }>;
}

export interface UninstallPreview {
  appId: string;
  /** False when the app has no syncable namespace registered. */
  installed: boolean;
  tables: UninstallPreviewTable[];
  /** Null when the app never opted into app-specific file storage. */
  files: UninstallPreviewFiles | null;
}
