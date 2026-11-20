#!/usr/bin/env tsx
/**
 * Install (or reinstall, or update) the cloud data server.
 *
 * A thin wrapper over the `install-cloud-data-server` operation
 * (`src/operations/install-cloud-data-server.ts`), kept for the e2e harness
 * and the IAM trace capture. People run `starkeep setup --cloud`, and admin-web
 * runs the operation through `run-operation`.
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:install-cloud-data-server [--non-interactive] [--ephemeral]
 *
 * `--non-interactive` takes the admin's credentials from the environment only.
 * Otherwise they come from the environment or the admin session
 * (`starkeep login --admin`). `--ephemeral` provisions disposable
 * infrastructure for the e2e harness (see `isEphemeralInstall`).
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";

// TEMP (iam-permission-tests POC): record every AWS SDK call this process makes
// when IAM_SDK_TRACE_PATH is set. Must run before any AWS SDK client exists.
if (process.env.IAM_SDK_TRACE_PATH) {
  const { installSdkTrace } = await import("../../iam-permission-tests/src/sdk-trace");
  installSdkTrace(process.env.IAM_SDK_TRACE_PATH);
}

const { isEphemeralInstall } = await import("../src/builtin-installs");
const { runForTerminal } = await import("../src/operations/human");

const flags = process.argv.slice(2);
await runForTerminal(
  "install-cloud-data-server",
  { ephemeral: isEphemeralInstall(flags) },
  { environmentOnly: flags.includes("--non-interactive") },
);
