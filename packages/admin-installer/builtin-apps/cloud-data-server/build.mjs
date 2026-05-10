#!/usr/bin/env node
/**
 * Build dist.zip — the Lambda artifact for the cloud-data-server built-in app.
 *
 * 1. Build all required workspace packages (tsup → dist/) so esbuild can
 *    resolve their compiled JS. `pnpm --filter` runs each in dependency order.
 * 2. Bundle src/api-handler.ts via esbuild — externalize nothing; everything
 *    (workspace deps, AWS SDK, pg) ends up in a single output file. AWS Lambda
 *    runtimes don't pre-include @aws-sdk/* on Node 22.x, so bundling them is
 *    correct.
 * 3. Zip the bundle output into dist.zip alongside this script.
 *
 * Output: packages/admin-installer/builtin-apps/cloud-data-server/dist.zip
 *
 * The zip is referenced by pulumi-program.ts via
 *   code: new pulumi.asset.FileArchive(distZipPath)
 * so its layout is "files at the zip root" — `api-handler.handler` resolves to
 * api-handler.js's `handler` export.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = __dirname;
const repoRoot = resolve(pkgDir, "..", "..", "..", "..");
const stagingDir = join(pkgDir, ".build-staging");
const outputZip = join(pkgDir, "dist.zip");

// Workspace packages the Lambda depends on, in dependency order.
const WS_PACKAGES = [
  "@starkeep/core",
  "@starkeep/storage-adapter",
  "@starkeep/storage-s3",
  "@starkeep/storage-aurora-dsql",
  "@starkeep/sync-engine",
];

console.log("Building workspace packages…");
for (const pkg of WS_PACKAGES) {
  console.log(`  pnpm build: ${pkg}`);
  execSync(`pnpm --filter "${pkg}" build`, {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true });
mkdirSync(stagingDir, { recursive: true });

console.log("Bundling api-handler with esbuild…");
await build({
  entryPoints: [join(pkgDir, "src", "api-handler.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(stagingDir, "api-handler.js"),
  external: [],
  // ESM Lambda needs an explicit .mjs / banner trick or package.json type=module.
  // Easier path: emit CJS so the .js extension just works under Lambda's require().
  // (Override format above if you'd rather ship ESM.)
  banner: { js: "" },
});

// Lambda's default loader expects CommonJS unless package.json type=module is in the zip,
// or the file is named .mjs. We emitted .js as ESM above which won't load — switch to CJS.
console.log("Re-bundling as CommonJS (Lambda's default loader)…");
await build({
  entryPoints: [join(pkgDir, "src", "api-handler.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(stagingDir, "api-handler.js"),
  external: [],
  allowOverwrite: true,
});

console.log("Creating dist.zip…");
if (existsSync(outputZip)) rmSync(outputZip);
execSync(`zip -j "${outputZip}" api-handler.js`, {
  cwd: stagingDir,
  stdio: "inherit",
});

rmSync(stagingDir, { recursive: true });

console.log(`\nBuilt: ${outputZip}`);
