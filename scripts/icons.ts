#!/usr/bin/env tsx
/**
 * Writes core's favicons from the one definition of the star in
 * `packages/admin-installer/src/starkeep-star.ts`. The managed login branding
 * draws from the same module at install time, so nothing copies the star by
 * hand.
 *
 * Edit the star in that module, run `pnpm icons`, and commit what it writes.
 * `--check` writes nothing and fails when a committed icon differs from what
 * this script would write.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_STAR, DRIVE_STAR, starSvg } from "../packages/admin-installer/src/starkeep-star";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ICONS = [
  { file: "apps/admin-web/src/icon.svg", source: starSvg(ADMIN_STAR, "Starkeep Admin") },
  { file: "apps/drive/src/icon.svg", source: starSvg(DRIVE_STAR, "Starkeep Drive") },
];

const check = process.argv.includes("--check");
const problems: string[] = [];

for (const icon of ICONS) {
  const path = resolve(root, icon.file);
  if (check) {
    let committed: string | null = null;
    try {
      committed = readFileSync(path, "utf8");
    } catch {}
    if (committed !== icon.source) problems.push(`${icon.file}: differs from the generated SVG`);
  } else {
    writeFileSync(path, icon.source);
    console.log(`wrote ${icon.file}`);
  }
}

if (problems.length > 0) {
  console.error("Icons differ from packages/admin-installer/src/starkeep-star.ts:");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\nEdit the star in starkeep-star.ts, run `pnpm icons`, and commit what it writes.",
  );
  process.exit(1);
}
if (check) console.log(`check-icons: ${ICONS.length} icons match starkeep-star.ts.`);
