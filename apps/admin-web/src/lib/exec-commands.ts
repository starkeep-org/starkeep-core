import "server-only";
import { resolve } from "node:path";

export type DaemonId = "local-data-server";
export type StreamCommandId = "reset-local-data";

// Next.js runs from apps/admin-web; ../../ is the repo root
export const REPO_ROOT = resolve(process.cwd(), "../..");

export const DAEMON_COMMANDS: Record<DaemonId, { args: string[] }> = {
  "local-data-server": { args: ["pnpm", "--filter", "@starkeep/local-data-server", "start"] },
};

// Cloud-side install/reset is no longer a shelled-out stream — it runs in-
// process via /api/cloud-data-server/install (see admin-installer's
// installCloudDataServer). reset-cloud-data is unimplemented in the new model.
export const STREAM_COMMANDS: Record<StreamCommandId, { args: string[]; requiresCreds: boolean }> = {
  "reset-local-data": {
    args: ["bash", "scripts/reset-local-data.sh", "--yes"],
    requiresCreds: false,
  },
};
