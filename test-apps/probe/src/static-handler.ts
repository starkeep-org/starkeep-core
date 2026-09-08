/**
 * The `static` handler: everything a browser reaches — the shell, the sign-in
 * page, the immutable asset, the session routes and the signing proxy.
 *
 * Declared `auth: "session"` in the manifest, so the gateway's session
 * authorizer gates every path except the ones the manifest lists as public.
 *
 * The whole adapter is the platform's. Probe used to carry its own copy of
 * base-path stripping, API Gateway payload encoding and cookie handling, which
 * is exactly the duplication `@starkeep/app-client/web` exists to end — and
 * Probe is the fixture the platform installs to prove its own contract, so an
 * adapter that cannot serve Probe is wrong.
 *
 * `createWebAppHandler` awaits the app's module graph at module scope, so the
 * graph loads during Lambda's INIT phase rather than inside the first request.
 */

import { createWebAppHandler } from "@starkeep/app-client/web";
import manifest from "../starkeep.manifest.json" with { type: "json" };

const shell = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!shell) throw new Error("probe manifest has no `static` compute handler");

export const handler = await createWebAppHandler({
  // The platform mounts the app here, and the Lambda sees the full path.
  basePath: `/apps/${manifest.id}`,
  // Staged by build.mjs from the same `assetScript()` the local server answers
  // with, so the two surfaces return identical bytes.
  assetsDir: new URL("./assets/", import.meta.url),
  // From the manifest, never a second hand-written copy: the static branch runs
  // before the app's gate, so this list is an enforcement bypass by
  // construction and the schema refuses an entry `publicPaths` does not cover.
  staticPaths: shell.staticAssetPaths,
  // `.then` on an already-started import, not a thunk: the app names its entry
  // `handleRequest`, and the mapping still settles during INIT.
  requestUpstream: import("./app.js").then((m) => ({ handler: m.handleRequest })),
  // Answered rather than thrown: a thrown Lambda error becomes a bare 502 with
  // nothing in the response to say what failed, and this fixture exists to make
  // platform failures legible.
  onError: (err) => ({
    statusCode: 500,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: `probe static handler: ${String(err)}` }),
  }),
});
