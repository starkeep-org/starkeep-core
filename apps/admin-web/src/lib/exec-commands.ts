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

// Each daemon resolves its own listen port from the environment, and admin-web
// must read the *same* variable: daemons are spawned as children and inherit
// this process's env, so a hardcoded copy here would silently disagree with the
// port the daemon actually binds. That disagreement is not theoretical — status
// would probe the wrong port and report not-running, and Start would then spawn
// a duplicate that collides with the instance already serving.
function daemonPort(envVar: string, fallback: number): number {
  const port = parseInt(process.env[envVar] ?? "", 10);
  return Number.isNaN(port) ? fallback : port;
}

// Workspace daemons spawned from REPO_ROOT with a pnpm filter. These are not
// "installed apps" — they're parts of the platform that admin-web can bring up
// for local dev. (Installed apps come from a manifest's `localRun` block via
// app-scan; see daemon/route.ts.)
export const DAEMON_COMMANDS: Record<DaemonId, { args: string[]; port?: number }> = {
  // STARKEEP_PORT is the data server's own knob (see its server.ts).
  "local-data-server": {
    args: ["pnpm", "--filter", "@starkeep/local-data-server", "start"],
    port: daemonPort("STARKEEP_PORT", 9820),
  },
  // Starkeep Drive UI — a core workspace app (not a starkeep-apps app).
  // Spawned from the repo root via the workspace filter, like the data server.
  // `dev` mode (no prior build needed) suits the local-admin context, and its
  // package script reads STARKEEP_DRIVE_PORT to stay in step with this.
  drive: {
    args: ["pnpm", "--filter", "@starkeep/drive", "dev"],
    port: daemonPort("STARKEEP_DRIVE_PORT", 9830),
  },
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
