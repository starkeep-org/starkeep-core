#!/usr/bin/env node
/**
 * What the manifest's `localRun` starts.
 *
 * `serve.mjs` and `assets/` are build artifacts rather than checked-in files, so
 * this entry point builds them when either is missing and then runs the server. Self-healing on purpose:
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

if (!existsSync(bundle) || !existsSync(join(pkgDir, "assets"))) {
  console.log("probe: serve.mjs or assets/ is missing, building them…");
  execFileSync(process.execPath, [join(pkgDir, "build.mjs"), "--local"], {
    cwd: pkgDir,
    stdio: "inherit",
  });
}

process.argv.splice(1, 1, bundle);
await import(bundle);
