import "server-only";
import { resolve } from "node:path";

export type DaemonId = "local-data-server" | "drive";
export type StreamCommandId = "reset-local-data" | "local-deploy";

// Next.js runs from apps/admin-web; ../../ is the repo root
export const REPO_ROOT = resolve(process.cwd(), "../..");

export const DAEMON_COMMANDS: Record<DaemonId, { args: string[]; port?: number }> = {
  "local-data-server": { args: ["pnpm", "--filter", "@starkeep/local-data-server", "start"], port: 9820 },
  // Starkeep Drive UI — a core workspace app (not a starkeep-apps app), fixed
  // port. Spawned from the repo root via the workspace filter, like the data
  // server. `dev` mode (no prior build needed) suits the local-admin context.
  drive: { args: ["pnpm", "--filter", "@starkeep/drive", "dev"], port: 9830 },
};

// Installed local apps that can be started/stopped from admin-web. Keyed by
// the app's manifest id (matches what /api/apps/list returns). `cwd` is
// resolved relative to the starkeep-apps directory (sibling of REPO_ROOT).
// `args(port)` returns the spawn argv with a caller-chosen free port wired in
// — apps inherit no fixed port so two apps can't collide and we never crash
// because admin-web is already on 3000.
export interface AppDaemonConfig {
  cwd: string;
  args: (port: number) => string[];
}
export const APP_DAEMONS: Record<string, AppDaemonConfig> = {
  // pnpm forwards args after the script name to the underlying command. No
  // `--` separator: with the separator pnpm passes it through verbatim and
  // next/vite then interpret `--` as a positional (e.g. project directory),
  // breaking the run.
  photos: { cwd: "photos", args: (p) => ["pnpm", "dev", "-p", String(p)] },
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
