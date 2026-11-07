#!/usr/bin/env node
/**
 * Link starkeep-core's end-to-end harness into this app, before any e2e command.
 *
 * The harness (`@starkeep/e2e`, and `@starkeep/e2e-aws` for the cloud suite)
 * boots a real platform from core's source, so it exists only in a
 * starkeep-core checkout. Nothing in `package.json` names that checkout:
 * `pnpm install` never needs it, and a copy of this app installs anywhere.
 * This script finds core when a test needs it, checks it is usable, and links
 * the two harness packages into `node_modules/@starkeep/`.
 *
 * Where it looks, in order:
 *
 * 1. `STARKEEP_CORE_DIR`, when set.
 * 2. An enclosing starkeep-core checkout. The example app sits inside core, at
 *    `examples/example-app`.
 * 3. `starkeep-core` beside this repository's root.
 *
 * Copy this file into your own app, unchanged. Run it as
 * `node scripts/link-core-harness.mjs` before `playwright test`, or import
 * `coreDir()` from a test config that needs core's path.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** The folder holding the app's root `package.json`. */
const appRoot = resolve(here, "..");

function isCoreCheckout(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "e2e", "package.json"), "utf8"));
    return pkg.name === "@starkeep/e2e";
  } catch {
    return false;
  }
}

function enclosingCore(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (isCoreCheckout(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: appRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return appRoot;
  }
}

/**
 * The starkeep-core checkout the e2e suites run against. Throws with the path
 * it tried and the fix when no usable checkout is found.
 */
export function coreDir() {
  const fromEnv = process.env.STARKEEP_CORE_DIR;
  const candidate = fromEnv
    ? resolve(fromEnv)
    : (enclosingCore(appRoot) ?? resolve(repoRoot(), "..", "starkeep-core"));
  const fix = fromEnv
    ? "Point STARKEEP_CORE_DIR at a starkeep-core checkout, and run pnpm install there."
    : "Set STARKEEP_CORE_DIR to a starkeep-core checkout, or run pnpm install there.";
  if (!isCoreCheckout(candidate)) {
    throw new Error(
      `The e2e suites need a starkeep-core checkout. Looked in ${candidate} and found no e2e/package.json naming @starkeep/e2e. ${fix}`,
    );
  }
  // The harness's own dependencies, installed by `pnpm install` in core.
  if (!existsSync(join(candidate, "e2e", "node_modules", "@starkeep", "testkit"))) {
    throw new Error(
      `The e2e suites need a starkeep-core checkout with dependencies installed. Looked in ${candidate} and found no e2e/node_modules/@starkeep/testkit. ${fix}`,
    );
  }
  return candidate;
}

/** Point `node_modules/@starkeep/<name>` at core's harness folder. */
function link(core, name, folder) {
  const scope = join(appRoot, "node_modules", "@starkeep");
  mkdirSync(scope, { recursive: true });
  const at = join(scope, name);
  try {
    lstatSync(at);
    rmSync(at, { recursive: true, force: true });
  } catch {
    // Nothing there yet.
  }
  symlinkSync(join(core, folder), at, "dir");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const core = coreDir();
    link(core, "e2e", "e2e");
    link(core, "e2e-aws", "e2e-aws");
    console.log(`Linked the e2e harness from ${core}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
