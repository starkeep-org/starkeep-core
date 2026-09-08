#!/usr/bin/env node
/**
 * Build Probe for whichever surface it is being installed on.
 *
 * `--local` writes `serve.mjs` next to the manifest, which is what the
 * manifest's `localRun` starts. `--cloud` writes the two Lambda entry points
 * into a `dist.zip` at `STARKEEP_BUNDLE_OUT`, which is the contract
 * `cli-install-app` invokes an app's `pnpm bundle` under.
 *
 * Everything is bundled in: the Lambda runtime pre-includes nothing on Node 22,
 * and a local install of a fixture app must not need its own `pnpm install`.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkgDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(pkgDir, "..", "..");
const cloud = process.argv.includes("--cloud");

// @starkeep/app-client is consumed from its build output, so build it first.
// The fixture depends on the platform's own client library on purpose — that
// is what makes it a test of the library an app author would use.
execSync('pnpm --filter "@starkeep/app-client" build', { cwd: repoRoot, stdio: "inherit" });

if (!cloud) {
  await build({
    entryPoints: [join(pkgDir, "src", "serve.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: join(pkgDir, "serve.mjs"),
    // esbuild emits `import` for these under ESM; Node resolves them natively.
    external: ["node:*"],
    banner: {
      // The bundle pulls in CJS dependencies that expect `require`.
      js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);",
    },
  });
  console.log(`Built: ${join(pkgDir, "serve.mjs")}`);
} else {
  const out = process.env.STARKEEP_BUNDLE_OUT;
  if (!out) throw new Error("STARKEEP_BUNDLE_OUT is not set (cli-install-app sets it)");
  const staging = join(pkgDir, ".build-staging");
  if (existsSync(staging)) rmSync(staging, { recursive: true });
  mkdirSync(staging, { recursive: true });

  // ESM, emitted as `.mjs`: the entry uses top-level `await` so the app's
  // module graph loads during Lambda's INIT phase, and top-level await does not
  // exist in CommonJS. Lambda's Node runtime resolves the manifest's handler
  // strings (`static-handler.handler`, `api-handler.handler`) against `.mjs`
  // as readily as `.js`, so the outputs are named to match and nothing about
  // the manifest changes.
  const esbuildCommon = {
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // esbuild emits `import` for these under ESM; Node resolves them natively.
    external: ["node:*"],
    banner: {
      // The bundle pulls in CJS dependencies that expect `require`.
      js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);",
    },
  };
  for (const entry of ["static-handler", "api-handler"]) {
    await build({
      ...esbuildCommon,
      entryPoints: [join(pkgDir, "src", `${entry}.ts`)],
      outfile: join(staging, `${entry}.mjs`),
    });
  }

  // Stage the shell's script as a file on disk, so the platform's web adapter
  // answers it the way it answers any app's static assets. The manifest's
  // `staticAssetPaths` is what tells the adapter it may, and the schema refuses
  // an entry `publicPaths` does not already declare.
  const writeAssets = join(staging, ".write-assets.mjs");
  await build({
    ...esbuildCommon,
    entryPoints: [join(pkgDir, "src", "write-assets.ts")],
    outfile: writeAssets,
  });
  execSync(`node "${writeAssets}" "${join(staging, "assets")}"`, { stdio: "inherit" });
  rmSync(writeAssets);

  mkdirSync(dirname(out), { recursive: true });
  if (existsSync(out)) rmSync(out);
  // -r, not -j: the assets directory has to keep its shape inside the zip,
  // because the adapter resolves paths under it.
  execSync(`zip -rq "${out}" static-handler.mjs api-handler.mjs assets`, {
    cwd: staging,
    stdio: "inherit",
  });
  rmSync(staging, { recursive: true });
  console.log(`Built: ${out}`);
}
