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
 *
 * Inlined modules see the bundle's `import.meta.url`, not their own, so code
 * that locates files relative to itself would resolve from the temp dir, and
 * only under this suite. Nothing in today's graph does that (the admin-installer
 * modules that do are not imported by server.ts), so each build fails loudly if
 * the output starts referring to its own location, naming the inlined sources
 * that do.
 *
 * globalSetup runs once per vitest session, so in watch mode the bundle is
 * rebuilt before each rerun (`project.onTestsRerun`, awaited before the files
 * run); otherwise an edit to server.ts or to the `packages/*\/src` it imports
 * would never reach the spawned server, where the tsx path picked it up per
 * spawn. The esbuild context keeps that rebuild incremental.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type BuildContext, context, type Plugin } from "esbuild";
import type { TestProject } from "vitest/node";

const LDS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_TS = join(LDS_DIR, "server.ts");
const BUILTINS = new Set(builtinModules);
const RESOLVING = Symbol("resolving");
const SELF_LOCATION = /import\.meta\.(?:url|dirname|filename)|\b__(?:dirname|filename)\b/;

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

async function rebuildChecked(bundle: BuildContext, entry: string): Promise<void> {
  const { metafile } = await bundle.rebuild();
  if (!SELF_LOCATION.test(await readFile(entry, "utf8"))) return;
  // Metafile paths are relative to `absWorkingDir`; externals are not inputs,
  // so every input here was inlined.
  const offenders: string[] = [];
  for (const input of Object.keys(metafile?.inputs ?? {})) {
    const path = resolve(LDS_DIR, input);
    if (SELF_LOCATION.test(await readFile(path, "utf8"))) offenders.push(path);
  }
  throw new Error(
    `The local-data-server bundle refers to its own location (import.meta.url, ` +
      `dirname or filename), which resolves from the bundle's temp dir rather than ` +
      `the source file. Inlined sources that do this: ${offenders.join(", ") || "(unknown)"}. ` +
      `Mark them external in global-setup.ts or stop importing them from server.ts.`,
  );
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "starkeep-lds-bundle-"));
  const entry = join(dir, "server.mjs");
  const bundle = await context({
    entryPoints: [SERVER_TS],
    absWorkingDir: LDS_DIR,
    outfile: entry,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    // Node's resolution, not a bundler's: no "module" condition, `main` only.
    conditions: [],
    mainFields: ["main"],
    plugins: [externalsFromImporter],
    metafile: true,
    logLevel: "warning",
  });
  await rebuildChecked(bundle, entry);
  process.env.STARKEEP_LDS_ENTRY = entry;
  project.onTestsRerun(async () => {
    await rebuildChecked(bundle, entry);
  });
  return async () => {
    delete process.env.STARKEEP_LDS_ENTRY;
    await bundle.dispose();
    await rm(dir, { recursive: true, force: true });
  };
}
