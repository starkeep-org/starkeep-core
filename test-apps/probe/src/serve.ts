/**
 * The local surface: the platform's `serveLocal` in front of the app.
 *
 * `serveLocal` binds `127.0.0.1` on the port admin-web passed, refuses a
 * request with a non-loopback `Host` or from a page on another site before any
 * route runs, and answers static files with `serveStatic`'s responder ahead of
 * the app, which is where the cloud adapter serves them too.
 *
 * A locally installed app is started by admin-web's daemon route, which spawns
 * the manifest's `localRun` command and passes the port it allocated on
 * `portFlag`. Probe's `localRun` runs the built `serve.mjs`, which is this file
 * bundled — a local install therefore needs no dependency install of its own,
 * which is what lets the tier-2 harness treat it as a throwaway fixture.
 *
 * The `node:http` bridge is the library's rather than ours: streaming in both
 * directions, early client close, `HEAD`, and the
 * `Content-Length`-versus-chunked decision are all decided the same way here
 * and in the Lambda, because both surfaces hand the same `app.fetch` the same
 * web `Request`.
 */

import { serveLocal } from "@starkeep/app-client/local";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { app } from "./app.js";

const shell = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!shell?.staticAssetPaths) {
  throw new Error("probe manifest has no `static` compute handler with `staticAssetPaths`");
}

// The same static responder the cloud adapter runs, over the same staged bytes
// (`build.mjs --local` writes `assets/` beside this bundle), so the immutable
// asset's content type, cache header and ETag cannot differ between surfaces.
serveLocal({
  app,
  static: {
    assetsDir: new URL("./assets/", import.meta.url),
    staticPaths: shell.staticAssetPaths,
    immutablePaths: ["/_immutable/*"],
  },
  onListen: ({ url }) => console.log(`probe listening on ${url}`),
});
