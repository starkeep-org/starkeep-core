import "server-only";
import { resolve } from "node:path";

export type DaemonId = "data-server" | "photos-web" | "file-browser";
export type StreamCommandId = "reset-local-data" | "local-deploy" | "reset-cloud-data";

// Next.js runs from apps/admin-web; ../../ is the repo root
export const REPO_ROOT = resolve(process.cwd(), "../..");

export const DAEMON_COMMANDS: Record<DaemonId, { args: string[] }> = {
  "data-server": { args: ["pnpm", "--filter", "@starkeep/data-server", "start"] },
  "photos-web": { args: ["pnpm", "--filter", "photos-web", "dev"] },
  "file-browser": { args: ["pnpm", "--filter", "@starkeep/file-browser", "dev"] },
};

export const STREAM_COMMANDS: Record<StreamCommandId, { args: string[]; requiresCreds: boolean }> = {
  "reset-local-data": {
    args: ["bash", "scripts/reset-local-data.sh", "--yes"],
    requiresCreds: false,
  },
  "local-deploy": {
    args: ["pnpm", "--filter", "@starkeep/infra-user-data", "local:deploy", "--", "--non-interactive"],
    requiresCreds: true,
  },
  "reset-cloud-data": {
    args: ["pnpm", "--filter", "@starkeep/infra-user-data", "reset-cloud-data", "--", "--non-interactive", "--yes"],
    requiresCreds: true,
  },
};
