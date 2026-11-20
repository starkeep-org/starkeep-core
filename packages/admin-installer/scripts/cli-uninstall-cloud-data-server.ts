#!/usr/bin/env tsx
/**
 * Uninstall the cloud data server and all of its AWS resources, Drive first.
 * A thin wrapper over the `uninstall-cloud-data-server` operation
 * (`src/operations/uninstall-cloud-data-server.ts`).
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer exec tsx scripts/cli-uninstall-cloud-data-server.ts [--non-interactive]
 *
 * Without `--non-interactive`, it asks for "yes" first.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { prompt } from "../src/cli-prompt";
import { runForTerminal } from "../src/operations/human";
import { DESTROY_WARNING } from "../src/operations/uninstall-cloud-data-server";

const nonInteractive = process.argv.slice(2).includes("--non-interactive");
if (!nonInteractive) {
  console.log(`\nWARNING: ${DESTROY_WARNING}\n`);
  if ((await prompt('Type "yes" to continue: ')).trim() !== "yes") {
    console.log("Aborted.");
    process.exit(0);
  }
}
await runForTerminal(
  "uninstall-cloud-data-server",
  { confirm: true },
  { environmentOnly: nonInteractive },
);
