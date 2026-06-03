import "server-only";
import { resolve } from "node:path";

export type DaemonId = "local-data-server" | "drive";
export type StreamCommandId = "reset-local-data" | "local-deploy";

// Next.js runs from apps/admin-web; ../../ is the repo root
export const REPO_ROOT = resolve(process.cwd(), "../..");

// Default app parent dir: the sibling-of-starkeep-core `starkeep-apps/` checkout.
// Seeded into `appParentDirs` in ~/.starkeep/config.json on first read by the
// config route so it shows up as a normal, removable entry in the UI list.
export const DEFAULT_APPS_DIR = resolve(REPO_ROOT, "..", "starkeep-apps");

// Workspace daemons spawned from REPO_ROOT with a fixed port and pnpm filter.
// These are not "installed apps" — they're parts of the platform that admin-web
// can bring up for local dev. (Installed apps come from a manifest's
// `localRun` block via app-scan; see daemon/route.ts.)
export const DAEMON_COMMANDS: Record<DaemonId, { args: string[]; port?: number }> = {
  "local-data-server": { args: ["pnpm", "--filter", "@starkeep/local-data-server", "start"], port: 9820 },
  // Starkeep Drive UI — a core workspace app (not a starkeep-apps app), fixed
  // port. Spawned from the repo root via the workspace filter, like the data
  // server. `dev` mode (no prior build needed) suits the local-admin context.
  drive: { args: ["pnpm", "--filter", "@starkeep/drive", "dev"], port: 9830 },
};

// Cloud-side install/reset is no longer a shelled-out stream — it runs in-
// process via /api/cloud-data-server/install (see admin-installer's
// installCloudDataServer). reset-cloud-data is unimplemented in the new model.
export const STREAM_COMMANDS: Record<StreamCommandId, { args: string[]; requiresCreds: boolean }> = {
  "reset-local-data": {
    args: ["bash", "scripts/reset-local-data.sh", "--yes"],
    requiresCreds: false,
  },
  "local-deploy": {
    args: ["pnpm", "--filter", "@starkeep/admin-installer", "cli:install-cloud-data-server", "--non-interactive"],
    requiresCreds: true,
  },
};
