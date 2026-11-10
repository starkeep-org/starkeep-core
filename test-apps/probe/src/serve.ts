/**
 * The local surface: `@hono/node-server` in front of the app.
 *
 * Static files go through `serveStatic`, the platform's responder, ahead of
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

import { serve } from "@hono/node-server";
import { serveStatic } from "@starkeep/app-client/hono";
import { Hono } from "hono";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { app } from "./app.js";

const shell = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!shell?.staticAssetPaths) {
  throw new Error("probe manifest has no `static` compute handler with `staticAssetPaths`");
}

// The same static responder the cloud adapter runs, over the same staged bytes
// (`build.mjs --local` writes `assets/` beside this bundle), so the immutable
// asset's content type, cache header and ETag cannot differ between surfaces.
const local = new Hono();
local.use(
  "*",
  serveStatic({
    assetsDir: new URL("./assets/", import.meta.url),
    staticPaths: shell.staticAssetPaths,
    immutablePaths: ["/_immutable/*"],
  }),
);
local.all("*", (c) => app.fetch(c.req.raw));

function portFromArgv(argv: string[]): number {
  const at = argv.indexOf("--port");
  const value = at >= 0 ? Number(argv[at + 1]) : Number(process.env.PORT);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      "probe needs a port: --port <n> (admin-web passes it via the manifest portFlag)",
    );
  }
  return value;
}

const port = portFromArgv(process.argv.slice(2));

serve({ fetch: local.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`probe listening on http://127.0.0.1:${port}`);
});
