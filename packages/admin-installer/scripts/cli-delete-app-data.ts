#!/usr/bin/env tsx
/**
 * Delete the data a cloud uninstall kept for one app. A thin wrapper over the
 * `delete-app-data` operation (`src/operations/delete-app-data.ts`), kept for
 * the e2e harness; people run `starkeep uninstall <app> --cloud --delete-data`.
 *
 * It prints what it would delete, by counts, then asks for the app id typed
 * back. A non-interactive run deletes only with `--confirm <appId>`.
 *
 * Usage:
 *   pnpm --filter @starkeep/admin-installer cli:delete-app-data <appId>
 *   pnpm --filter @starkeep/admin-installer cli:delete-app-data <appId> --non-interactive --confirm <appId>
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR is populated.
import "@starkeep/app-client/load-env";
import { takeFlagValue } from "../src/app-cli-config";
import { prompt } from "../src/cli-prompt";
import { runForTerminal } from "../src/operations/human";

let flags: string[];
let confirm: string | undefined;
try {
  ({ value: confirm, rest: flags } = takeFlagValue(
    process.argv.slice(2),
    "--confirm",
    "the app id",
  ));
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const nonInteractive = flags.includes("--non-interactive");
const appId = flags.find((f) => !f.startsWith("--"));
if (!appId) {
  console.error("Usage: cli:delete-app-data <appId> [--non-interactive --confirm <appId>]");
  process.exit(1);
}
if (nonInteractive && confirm !== appId) {
  console.error(
    `Error: --non-interactive deletes data only with --confirm ${appId}. Nothing changed.`,
  );
  process.exit(1);
}

await runForTerminal(
  "delete-app-data",
  { appId, ...(confirm !== undefined ? { confirm } : {}) },
  {
    environmentOnly: nonInteractive,
    overrides: {
      confirmDeletion: async () =>
        (await prompt(`\nType ${appId} to delete its cloud data: `)).trim() === appId,
    },
  },
);
