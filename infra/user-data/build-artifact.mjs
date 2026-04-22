#!/usr/bin/env node
/**
 * Builds user-data-source.zip for CodeBuild deployment.
 *
 * The zip must be self-contained because CodeBuild has no access to the pnpm
 * workspace. This script:
 *   1. Builds each required workspace package (tsup → dist/)
 *   2. Copies the built packages into .ws/ with workspace:* refs replaced by
 *      relative file: refs pointing within .ws/
 *   3. Rewrites package.json with file:.ws/X refs and generates package-lock.json
 *   4. Zips everything (src/, sst.config.ts, .ws/, package.json, package-lock.json)
 *   5. Restores the original package.json and cleans up
 */

import { execSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import os from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const infraDir = __dirname;
const repoRoot = resolve(infraDir, "../..");
const wsDir = join(infraDir, ".ws");
const outputZip = join(repoRoot, "apps/admin-desktop/public/user-data-source.zip");

// Workspace packages needed by infra/user-data, in dependency order.
// dir = folder name under packages/ and .ws/
const WS_PACKAGES = [
  { name: "@starkeep/core", dir: "core" },
  { name: "@starkeep/storage-adapter", dir: "storage-adapter" },
  { name: "@starkeep/storage-s3", dir: "storage-s3" },
  { name: "@starkeep/storage-aurora-dsql", dir: "storage-aurora-dsql" },
];

// Maps @starkeep/* → file: path as seen from infra/user-data/package.json
const nameToRootFile = Object.fromEntries(
  WS_PACKAGES.map((p) => [p.name, `file:.ws/${p.dir}`])
);

// Maps @starkeep/* → file: path as seen from inside .ws/<pkg>/package.json
const nameToRelFile = Object.fromEntries(
  WS_PACKAGES.map((p) => [p.name, `file:../${p.dir}`])
);

function replaceWorkspaceDeps(pkgJson, fileMap) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    if (!pkgJson[field]) continue;
    for (const [dep, ver] of Object.entries(pkgJson[field])) {
      if (typeof ver === "string" && ver.startsWith("workspace:")) {
        if (fileMap[dep]) {
          pkgJson[field][dep] = fileMap[dep];
        } else {
          // Unknown workspace package — remove so npm doesn't choke
          delete pkgJson[field][dep];
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Build workspace packages
// ---------------------------------------------------------------------------
console.log("Building workspace packages…");
for (const pkg of WS_PACKAGES) {
  console.log(`  pnpm build: ${pkg.name}`);
  execSync(`pnpm --filter "${pkg.name}" build`, {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

// ---------------------------------------------------------------------------
// 2. Populate .ws/
// ---------------------------------------------------------------------------
if (existsSync(wsDir)) rmSync(wsDir, { recursive: true });
mkdirSync(wsDir, { recursive: true });

for (const pkg of WS_PACKAGES) {
  const srcDir = join(repoRoot, "packages", pkg.dir);
  const destDir = join(wsDir, pkg.dir);
  mkdirSync(destDir, { recursive: true });

  // Copy pre-built dist/
  const distSrc = join(srcDir, "dist");
  if (existsSync(distSrc)) {
    cpSync(distSrc, join(destDir, "dist"), { recursive: true });
  }

  // Copy and patch package.json (workspace:* → file:../<dir>)
  const pkgJson = JSON.parse(readFileSync(join(srcDir, "package.json"), "utf8"));
  replaceWorkspaceDeps(pkgJson, nameToRelFile);
  writeFileSync(join(destDir, "package.json"), JSON.stringify(pkgJson, null, 2));
}

// ---------------------------------------------------------------------------
// 3. Create artifact package.json and generate a CLEAN package-lock.json
//    in an isolated tmp dir so pnpm's node_modules/ doesn't contaminate the
//    `resolved` paths with ../../node_modules/.pnpm/... references.
// ---------------------------------------------------------------------------
const origPkgJsonText = readFileSync(join(infraDir, "package.json"), "utf8");
const artifactPkgJson = JSON.parse(origPkgJsonText);
replaceWorkspaceDeps(artifactPkgJson, nameToRootFile);
const artifactPkgJsonText = JSON.stringify(artifactPkgJson, null, 2);

const lockTmpDir = mkdtempSync(join(os.tmpdir(), "starkeep-lockgen-"));
console.log(`Generating package-lock.json (isolated: ${lockTmpDir})…`);
try {
  writeFileSync(join(lockTmpDir, "package.json"), artifactPkgJsonText);
  cpSync(wsDir, join(lockTmpDir, ".ws"), { recursive: true });

  execSync("npm install --package-lock-only --ignore-scripts", {
    cwd: lockTmpDir,
    stdio: "inherit",
  });

  const lockText = readFileSync(join(lockTmpDir, "package-lock.json"), "utf8");
  if (lockText.includes("/.pnpm/") || /\"resolved\":\s*\"\.\.\//.test(lockText)) {
    throw new Error(
      "Generated package-lock.json contains pnpm/relative paths — artifact would be broken on CodeBuild"
    );
  }

  cpSync(join(lockTmpDir, "package-lock.json"), join(infraDir, "package-lock.json"));
} finally {
  rmSync(lockTmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. Temporarily swap package.json for zipping, then restore
// ---------------------------------------------------------------------------
writeFileSync(join(infraDir, "package.json"), artifactPkgJsonText);

console.log("Creating zip…");
if (existsSync(outputZip)) rmSync(outputZip);

try {
  execSync(
    `zip -r "${outputZip}" . \
      --exclude '.sst/*' \
      --exclude 'node_modules/*' \
      --exclude '*.zip' \
      --exclude 'build-artifact.mjs'`,
    { cwd: infraDir, stdio: "inherit" }
  );
} finally {
  writeFileSync(join(infraDir, "package.json"), origPkgJsonText);
  rmSync(join(infraDir, "package-lock.json"), { force: true });
}

console.log(`\nBuilt: ${outputZip}`);
