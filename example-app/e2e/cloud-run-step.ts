/**
 * Run one step of `@starkeep/e2e-aws`'s app cloud run in a child process.
 *
 * This process cannot import `@starkeep/e2e-aws`. The package loads core's
 * copy of Playwright, and Playwright refuses to load twice in one process,
 * so the import fails with "Requiring @playwright/test second time". A
 * child process loads only core's copy.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The example app's root, which holds its manifest. */
export const APP_ROOT = resolve(here, "..");

/** The run file `prepare` writes and the spec reads. Gitignored. */
export const CLOUD_RUN_FILE = join(here, ".cloud-run", "run.json");

export async function runCloudStep(args: string[]): Promise<void> {
  // `scripts/link-core-harness.mjs` linked the package before this run.
  const e2eAws = realpathSync(join(APP_ROOT, "node_modules", "@starkeep", "e2e-aws"));
  await new Promise<void>((done, fail) => {
    const child = spawn("pnpm", ["exec", "tsx", "src/app-cloud-run.ts", ...args], {
      cwd: e2eAws,
      stdio: "inherit",
    });
    child.once("error", fail);
    child.once("close", (code) =>
      code === 0 ? done() : fail(new Error(`app-cloud-run ${args[0]} exited with code ${code}`)),
    );
  });
}
