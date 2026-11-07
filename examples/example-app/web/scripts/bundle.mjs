#!/usr/bin/env node
/**
 * Build the cloud bundle: the contract `cli-install-app` calls `pnpm bundle`
 * under.
 *
 * The installer sets two variables:
 *
 * - `STARKEEP_APP_BASE_PATH`, the mount, such as `/apps/example-app`. Vite
 *   writes it into every asset URL.
 * - `STARKEEP_BUNDLE_OUT`, the absolute path of the `dist.zip` to write.
 *
 * The zip holds two Lambda entries and the page:
 *
 * - `index.mjs`, which the manifest's `static` handler names as `index.handler`;
 * - `api.mjs`, which the `api` handler names as `api.handler`;
 * - `assets/`, the built browser half the web adapter serves.
 *
 * Everything is bundled in, because the Lambda runtime provides no packages.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const webDir = dirname(dirname(fileURLToPath(import.meta.url)));

const basePath = process.env.STARKEEP_APP_BASE_PATH;
const out = process.env.STARKEEP_BUNDLE_OUT;
if (!basePath || !out) {
  console.error(
    "pnpm bundle needs STARKEEP_APP_BASE_PATH (such as /apps/example-app) and " +
      "STARKEEP_BUNDLE_OUT (an absolute path for dist.zip). The installer sets both.",
  );
  process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), "example-app-bundle-"));
try {
  const assets = join(staging, "assets");
  execFileSync("pnpm", ["exec", "vite", "build", "--outDir", assets, "--emptyOutDir"], {
    cwd: webDir,
    stdio: "inherit",
    env: { ...process.env, STARKEEP_APP_BASE_PATH: basePath, NODE_ENV: "production" },
  });
  if (!existsSync(join(assets, "index.html"))) {
    throw new Error(`Vite wrote no shell at ${join(assets, "index.html")}`);
  }

  for (const [entry, outfile] of [
    ["cloud.ts", "index.mjs"],
    ["api.ts", "api.mjs"],
  ]) {
    await build({
      entryPoints: [join(webDir, "src", "server", entry)],
      outfile: join(staging, outfile),
      bundle: true,
      platform: "node",
      target: "node22",
      // ESM, because `cloud.ts` uses top-level await to load the app during INIT.
      format: "esm",
      external: ["node:*"],
      banner: {
        // Some dependencies are CommonJS and expect `require`.
        js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);",
      },
    });
  }

  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true });
  // -r keeps `assets/` as a directory inside the zip, where the adapter looks.
  execFileSync("zip", ["-rq", out, "index.mjs", "api.mjs", "assets"], {
    cwd: staging,
    stdio: "inherit",
  });
  console.log(`Bundle written: ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
