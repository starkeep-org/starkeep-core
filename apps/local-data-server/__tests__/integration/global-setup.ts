/**
 * Bundles `server.ts` once per integration run so each of the ~60 server
 * spawns in this suite runs `node server.mjs` instead of paying tsx's
 * transpile of the server and its `../../packages/*\/src` imports on every boot.
 *
 * `@starkeep/testkit`'s `startLocalDataServer()` picks the bundle up through
 * `STARKEEP_LDS_ENTRY`; vitest's forks inherit this process's env, which
 * globalSetup has already modified by the time workers start. Every other
 * consumer of the harness leaves the variable unset and keeps the tsx path.
 *
 * Only first-party source is bundled. Every bare import (npm packages and the
 * `@starkeep/*` workspace packages, which resolve to their built `dist/` just
 * as they do under tsx) stays external — but Node resolves an external bare
 * specifier from the bundle's own location, which is a temp dir here and, even
 * if it were this package, would miss deps that only `packages/*` declare
 * (`@aws-sdk/client-iam`, `@starkeep/admin-manifest`). So each one is resolved
 * from the file that imports it, with Node's ESM conditions, and emitted as an
 * absolute `file:` URL: the same module Node would load running from source.
 *
 * The bundle dir must outlive every file: `restartProcess()` in server.ts
 * re-execs `process.argv[1]`, which is the bundle.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";

const SERVER_TS = resolve(dirname(fileURLToPath(import.meta.url)), "../../server.ts");
const BUILTINS = new Set(builtinModules);
const RESOLVING = Symbol("resolving");

const externalsFromImporter: Plugin = {
  name: "externals-from-importer",
  setup(b) {
    // Bare specifiers only: not relative, not absolute.
    b.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === RESOLVING) return undefined;
      if (args.path.startsWith("node:") || BUILTINS.has(args.path.split("/")[0])) {
        return { path: args.path, external: true };
      }
      const resolved = await b.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: RESOLVING,
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: pathToFileURL(resolved.path).href, external: true };
    });
  },
};

export default async function setup(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "starkeep-lds-bundle-"));
  const entry = join(dir, "server.mjs");
  await build({
    entryPoints: [SERVER_TS],
    outfile: entry,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    // Node's resolution, not a bundler's: no "module" condition, `main` only.
    conditions: [],
    mainFields: ["main"],
    plugins: [externalsFromImporter],
    logLevel: "warning",
  });
  process.env.STARKEEP_LDS_ENTRY = entry;
  return async () => {
    delete process.env.STARKEEP_LDS_ENTRY;
    await rm(dir, { recursive: true, force: true });
  };
}
