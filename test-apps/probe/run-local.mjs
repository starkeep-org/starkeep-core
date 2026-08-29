#!/usr/bin/env node
/**
 * What the manifest's `localRun` starts.
 *
 * `serve.mjs` is a build artifact rather than a checked-in file, so this entry
 * point builds it when it is missing and then runs it. Self-healing on purpose:
 * a fixture app that fails to start because someone forgot a build step would
 * report as a platform failure in whatever suite installed it, which is the
 * hardest kind of test failure to read.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(fileURLToPath(import.meta.url));
const bundle = join(pkgDir, "serve.mjs");

if (!existsSync(bundle)) {
  console.log("probe: serve.mjs is missing, building it…");
  execFileSync(process.execPath, [join(pkgDir, "build.mjs"), "--local"], {
    cwd: pkgDir,
    stdio: "inherit",
  });
}

process.argv.splice(1, 1, bundle);
await import(bundle);
