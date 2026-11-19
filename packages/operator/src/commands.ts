/**
 * The commands admin-web and the CLI spawn, and where they spawn them from.
 *
 * Server-side only. Nothing admin-web's browser half loads may import this
 * package: an eslint `no-restricted-imports` rule and admin-web's
 * `__tests__/server-module-isolation.test.ts` hold that line.
 */
import { repoRoot } from "./repo-root";

export type DaemonId = "local-data-server" | "drive";
export type StreamCommandId = "reset-local-data" | "local-deploy";

// See `repo-root.ts` for why the root comes from this file's location.
export const REPO_ROOT = repoRoot();

// Each daemon resolves its own listen port from the environment, and admin-web
// must read the *same* variable: daemons are spawned as children and inherit
// this process's env, so a hardcoded copy here would silently disagree with the
// port the daemon actually binds. That disagreement is not theoretical — status
// would probe the wrong port and report not-running, and Start would then spawn
// a duplicate that collides with the instance already serving.
export function daemonPort(envVar: string, fallback: number): number {
  const port = parseInt(process.env[envVar] ?? "", 10);
  return Number.isNaN(port) ? fallback : port;
}

// Workspace daemons spawned from REPO_ROOT with a pnpm filter. These are not
// "installed apps" — they're parts of the platform that admin-web can bring up
// for local dev. (Installed apps come from a manifest's `localRun` block via
// app-scan; see `apps.ts`.)
export const DAEMON_COMMANDS: Record<DaemonId, { args: string[]; port?: number }> = {
  // STARKEEP_PORT is the data server's own knob (see its server.ts).
  "local-data-server": {
    args: ["pnpm", "--filter", "@starkeep/local-data-server", "start"],
    port: daemonPort("STARKEEP_PORT", 9820),
  },
  // Starkeep Drive UI — a core workspace app (not a starkeep-apps app).
  // Spawned from the repo root via the workspace filter, like the data server.
  // `start`, not `dev`: the Dashboard starts the product, and Drive's server
  // builds its own browser bundle on first start if `dist/` is absent, so no
  // prior build step is required of the operator. Its package script reads
  // STARKEEP_DRIVE_PORT to stay in step with this.
  drive: {
    args: ["pnpm", "--filter", "@starkeep/drive", "start"],
    port: daemonPort("STARKEEP_DRIVE_PORT", 9830),
  },
};

// The UI's cloud install goes through /api/cloud-data-server/install, which
// runs the installer detached so it survives admin-web restarts (see
// admin-web's lib/install-stream.ts). `local-deploy` here has no caller in the UI.
// reset-cloud-data is unimplemented in the new model.
export const STREAM_COMMANDS: Record<StreamCommandId, { args: string[]; requiresCreds: boolean }> =
  {
    "reset-local-data": {
      args: ["bash", "scripts/reset-local-data.sh", "--yes"],
      requiresCreds: false,
    },
    "local-deploy": {
      args: [
        "pnpm",
        "--filter",
        "@starkeep/admin-installer",
        "cli:install-cloud-data-server",
        "--non-interactive",
      ],
      requiresCreds: true,
    },
  };
