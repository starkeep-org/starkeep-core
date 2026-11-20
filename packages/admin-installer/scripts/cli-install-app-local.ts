#!/usr/bin/env tsx
/**
 * Install a Starkeep app on this computer from the terminal, the way Admin's
 * Install button does. A thin wrapper over the `install-local-app` operation
 * (`src/operations/install-local-app.ts`); people run
 * `starkeep install <app> --local`.
 *
 * The script shows the same consent words as Admin's install dialog, and
 * nothing happens until the person approves. The local data server must be
 * running.
 *
 * Usage, from the root of starkeep-core:
 *   pnpm --filter @starkeep/admin-installer cli:install-app-local <app folder> [--yes]
 *
 * `--yes` approves without asking. Without a terminal, the script requires it.
 */

// First import: load repo-root .env / .env.local so STARKEEP_DIR and
// STARKEEP_PORT match what Admin and the data server use.
import "@starkeep/app-client/load-env";
import { typedPath } from "../src/app-discovery";
import { prompt } from "../src/cli-prompt";
import { OperationError } from "../src/operations/errors";
import { runForTerminal } from "../src/operations/human";
import { defaultDataServerUrl, localInstallConsent } from "../src/operations/install-local-app";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const positional = args.filter((a) => !a.startsWith("--"));
if (positional.length !== 1) {
  console.error("Usage: cli:install-app-local <app folder> [--yes]");
  process.exit(2);
}
const appDir = typedPath(positional[0]!);

let consent: ReturnType<typeof localInstallConsent>;
try {
  consent = localInstallConsent(appDir);
} catch (err) {
  console.error(err instanceof OperationError ? err.message : String(err));
  process.exit(1);
}

// The data server answers before the person is asked, so a stopped server
// fails here rather than after the consent.
const dataServerUrl = defaultDataServerUrl();
const health = await fetch(`${dataServerUrl}/health`).catch(() => null);
if (!health?.ok) {
  console.error(
    `The local data server at ${dataServerUrl} is not answering. Start it from Admin, then try again.`,
  );
  process.exit(1);
}

// The consent words, in the order Admin's dialog shows them.
console.log(`\nInstall ${consent.name}?\n`);
for (const line of consent.lines) console.log(line);
if (!yes) {
  if (!process.stdin.isTTY) {
    console.error("\nNo terminal to ask for approval. Pass --yes to approve.");
    process.exit(1);
  }
  if (!/^y(es)?$/i.test((await prompt("\nApprove and install? [y/N] ")).trim())) {
    console.log("Not installed.");
    process.exit(0);
  }
}

console.log("");
await runForTerminal("install-local-app", { appDir, approved: true, dataServerUrl });
