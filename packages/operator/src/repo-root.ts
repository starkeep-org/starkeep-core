/**
 * The Starkeep checkout this code runs from.
 *
 * Daemons and installer runs spawn from the checkout's root with a pnpm filter,
 * so every caller needs the same answer. The answer comes from this file's own
 * location, never from `process.cwd()`: admin-web and the CLI can both start
 * from any folder, and a root that followed the caller's folder would spawn
 * every daemon against the wrong tree.
 *
 * The walk stops at the first `pnpm-workspace.yaml` that lists `apps/*`. A
 * fixed depth broke whenever a module moved between packages, and a bare
 * "first workspace file" would stop at a nested workspace such as an app's own.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Whether `dir` holds the Starkeep workspace file. */
export function isStarkeepRoot(dir: string): boolean {
  const file = join(dir, "pnpm-workspace.yaml");
  if (!existsSync(file)) return false;
  try {
    return /^\s*-\s*["']?apps\/\*["']?\s*$/m.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/** The nearest folder at or above `start` that is the Starkeep checkout's root. */
export function findRepoRoot(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (isStarkeepRoot(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

let cached: string | undefined;

/** The checkout's root. Throws when this file sits outside a Starkeep checkout. */
export function repoRoot(): string {
  if (cached !== undefined) return cached;
  // The real path, so a symlinked `node_modules/@starkeep/operator` resolves to
  // the checkout that holds the package rather than the one that links it.
  const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const root = findRepoRoot(here);
  if (root === null) {
    throw new Error(`No Starkeep checkout encloses ${here}: no pnpm-workspace.yaml lists apps/*.`);
  }
  cached = root;
  return root;
}
