#!/usr/bin/env node
/**
 * Copies the docs the `starkeep` plugin's skills link into
 * `plugins/starkeep/ref/<same repo path>`.
 *
 * An installed plugin contains only `plugins/starkeep/`, so a skill cannot link
 * `docs/...` by repository path. Skills link `../../ref/<repo path>#anchor`
 * instead, and this script keeps those copies byte-identical to the
 * originals. CI runs it and fails on `git diff --exit-code plugins/starkeep/ref`,
 * so a doc edit must be followed by `node scripts/sync-plugin-ref.mjs`. `ref/`
 * is rebuilt from scratch on every run, so it holds exactly these files.
 * Node built-ins only; runs from any working directory.
 */

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const refRoot = join(repoRoot, "plugins", "starkeep", "ref");

const REF_FILES = [
  "docs/authoring-an-app.md",
  "docs/system-design.md",
  "docs/data-roles-and-permissions.md",
  "README.md",
  "example-app/README.md",
  "e2e/README.md",
];

// Start from empty so a file dropped from the list leaves no stale copy behind.
rmSync(refRoot, { recursive: true, force: true });
for (const file of REF_FILES) {
  const dest = join(refRoot, file);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(repoRoot, file), dest);
}

console.log(`synced ${REF_FILES.length} files into plugins/starkeep/ref`);
