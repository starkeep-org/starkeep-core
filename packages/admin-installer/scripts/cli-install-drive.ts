#!/usr/bin/env tsx
/**
 * Install (or reinstall, or update) Starkeep Drive, the User-Data-Owner
 * identity for all shared-record sync. Runs after the cloud data server.
 *
 * A thin wrapper over the `install-drive` operation
 * (`src/operations/install-drive.ts`), kept for the e2e harness.
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:install-drive [--non-interactive]
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { runForTerminal } from "../src/operations/human";

await runForTerminal(
  "install-drive",
  {},
  { environmentOnly: process.argv.slice(2).includes("--non-interactive") },
);
