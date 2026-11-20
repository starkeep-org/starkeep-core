#!/usr/bin/env tsx
/**
 * Uninstall an app from the cloud, keeping its data. A thin wrapper over the
 * `uninstall-cloud-app` operation (`src/operations/uninstall-cloud-app.ts`),
 * kept for the e2e harness; people run `starkeep uninstall <app> --cloud`.
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:uninstall-app <appId>
 *     [--non-interactive] [--web] [--mobile] [--app-dir <folder>]
 *
 * `--web` removes only the cloud web app, and `--mobile` only the mobile app;
 * either keeps the data side. With neither, the app goes entirely.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { takeAppDirFlag } from "../src/app-cli-config";
import type { AppSurface } from "../src/orchestrator";
import { runForTerminal } from "../src/operations/human";

let flags: string[];
let appDir: string | undefined;
try {
  ({ appDir, rest: flags } = takeAppDirFlag(process.argv.slice(2)));
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const surfaces: AppSurface[] = [
  ...(flags.includes("--web") ? (["web"] as const) : []),
  ...(flags.includes("--mobile") ? (["mobile"] as const) : []),
];
const appId = flags.find((f) => !f.startsWith("--"));
if (!appId) {
  console.error(
    "Usage: cli:uninstall-app <appId> [--non-interactive] [--web] [--mobile] [--app-dir <folder>]",
  );
  process.exit(1);
}

await runForTerminal(
  "uninstall-cloud-app",
  {
    appId,
    ...(appDir !== undefined ? { appDir } : {}),
    ...(surfaces.length > 0 ? { surfaces } : {}),
  },
  { environmentOnly: flags.includes("--non-interactive") },
);
