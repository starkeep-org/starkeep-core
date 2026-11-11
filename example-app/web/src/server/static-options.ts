/**
 * The static options both surfaces pass to the platform's static responder:
 * `serveStatic` in `local.ts` and `createWebAppHandler` in `cloud.ts`.
 *
 * One copy, so the two surfaces cannot disagree about which paths are files,
 * which are content-hashed, or which answer with the shell. Only the directory
 * differs: the local surface serves `dist/`, and the cloud bundle stages the
 * same build as `assets/` beside the Lambda entry.
 */

import type { serveStatic } from "@starkeep/app-client/hono";
import manifest from "../../../starkeep.manifest.json" with { type: "json" };

type StaticOptions = Parameters<typeof serveStatic>[0];

const shell = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!shell?.staticAssetPaths) {
  throw new Error("the manifest has no `static` compute handler with `staticAssetPaths`");
}
const staticAssetPaths = shell.staticAssetPaths;

/** The browser routes that answer with the shell, `index.html`. */
const SHELL_PATHS = ["/"];

export function staticOptions(assetsDir: URL): StaticOptions {
  return {
    assetsDir,
    // From the manifest, never a second copy: the static branch runs before the
    // app's gate, so this list bypasses the gate by construction. The schema
    // refuses an entry `publicPaths` does not cover.
    staticPaths: staticAssetPaths.filter((p) => !SHELL_PATHS.includes(p)),
    shellPaths: SHELL_PATHS,
    immutablePaths: ["/_immutable/*"],
    staticMiss: "notFound",
  };
}
