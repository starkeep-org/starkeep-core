#!/usr/bin/env node
/**
 * Build dist.zip — the Lambda artifact for the cloud-data-server built-in app.
 *
 * 1. Build all required workspace packages (tsup → dist/) so esbuild can
 *    resolve their compiled JS. `pnpm --filter` runs each in dependency order.
 * 2. Bundle src/api-handler.ts via esbuild — externalize nothing; everything
 *    (workspace deps, AWS SDK, pg) ends up in a single output file. The
 *    Lambda runtime ships its own @aws-sdk/* copy, but bundling pins the
 *    version the handler was built and tested against.
 * 3. Zip the bundle output into dist.zip alongside this script.
 *
 * Output: packages/admin-installer/builtin-apps/cloud-data-server/dist.zip
 *
 * The zip is referenced by pulumi-program.ts via
 *   code: new pulumi.asset.FileArchive(distZipPath)
 * so its layout is "files at the zip root" — `api-handler.handler` resolves to
 * api-handler.js's `handler` export.
 *
 * The zip carries five entry points. The session, origin and delegated
 * authorizers are much smaller Lambdas that share this artifact rather than
 * getting their own: each is deployed alongside the broker, versioned with
 * it, and giving each a separate build would be a second thing to remember
 * to rebuild. The job dispatcher (`dispatcher.handler`) shares the broker's
 * code and role, so it ships in the same artifact.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
  "@starkeep/app-client",
  "@starkeep/protocol-primitives",
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

// CommonJS, because Lambda's default loader expects it unless the zip carries
// a package.json with type=module or the file is named .mjs.
// Each entry's output name, and the source file it bundles.
const ENTRIES = {
  "api-handler": "api-handler",
  "session-authorizer": "session-authorizer",
  "origin-authorizer": "origin-authorizer",
  "delegated-authorizer": "delegated-authorizer",
  dispatcher: "dispatcher-handler",
};
for (const [entry, source] of Object.entries(ENTRIES)) {
  console.log(`Bundling ${entry} with esbuild…`);
  await build({
    entryPoints: [join(pkgDir, "src", `${source}.ts`)],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: join(stagingDir, `${entry}.js`),
    external: [],
  });
}

console.log("Creating dist.zip…");
if (existsSync(outputZip)) rmSync(outputZip);
execSync(
  `zip -j "${outputZip}" ${Object.keys(ENTRIES)
    .map((entry) => `${entry}.js`)
    .join(" ")}`,
  {
    cwd: stagingDir,
    stdio: "inherit",
  },
);

rmSync(stagingDir, { recursive: true });

console.log(`\nBuilt: ${outputZip}`);
