#!/usr/bin/env tsx
/**
 * Install (or reinstall, or update) an app in the cloud.
 *
 * A thin wrapper over the `install-cloud-app` operation
 * (`src/operations/install-cloud-app.ts`), which documents the bundle
 * contract. Kept for the e2e harness and the IAM trace capture; people run
 * `starkeep install <app> --cloud`.
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:install-app <appId>
 *     [--non-interactive] [--web] [--mobile] [--app-dir <folder>] [--manifest-digest <hex>]
 *
 * `--web` adds the cloud web app, and `--mobile` the mobile app. With neither,
 * the install adds every surface the manifest offers.
 */

// TEMP (iam-permission-tests POC): record every AWS SDK call this process makes
// when IAM_SDK_TRACE_PATH is set. Must run before any AWS SDK client exists.
if (process.env.IAM_SDK_TRACE_PATH) {
  const { installSdkTrace } = await import("../../iam-permission-tests/src/sdk-trace");
  installSdkTrace(process.env.IAM_SDK_TRACE_PATH);
}
// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { takeAppDirFlag, takeFlagValue } from "../src/app-cli-config";
import type { AppSurface } from "../src/orchestrator";

let flags: string[];
let appDir: string | undefined;
let manifestDigest: string | undefined;
try {
  const taken = takeAppDirFlag(process.argv.slice(2));
  appDir = taken.appDir;
  ({ value: manifestDigest, rest: flags } = takeFlagValue(
    taken.rest,
    "--manifest-digest",
    "a digest",
  ));
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
    "Usage: cli:install-app <appId> [--non-interactive] [--web] [--mobile] [--app-dir <folder>] [--manifest-digest <hex>]",
  );
  process.exit(1);
}

const { runForTerminal } = await import("../src/operations/human");
await runForTerminal(
  "install-cloud-app",
  {
    appId,
    ...(appDir !== undefined ? { appDir } : {}),
    ...(surfaces.length > 0 ? { surfaces } : {}),
    ...(manifestDigest !== undefined ? { manifestDigest } : {}),
  },
  { environmentOnly: flags.includes("--non-interactive") },
);
