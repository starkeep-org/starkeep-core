/**
 * The local surface: what the manifest's `localRun` starts.
 *
 * admin-web runs `pnpm start` in this folder and passes the port it chose on
 * `--port`. The `start` script builds the browser half first, so the server
 * never serves stale browser code, then runs this file.
 *
 * This file adds the one thing the cloud's web adapter does that the shared
 * Hono app does not: serving the built browser half from `dist/`. It mounts the
 * platform's `serveStatic`, the same responder the cloud adapter runs, with
 * the same options, so both surfaces answer the same paths with the same
 * headers. Everything else falls through to `app.ts`.
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@starkeep/app-client/hono";
import { Hono } from "hono";
import { app } from "./app.js";
import { staticOptions } from "./static-options.js";

/**
 * The bind keeps other devices out. The `Host` check keeps out a DNS-rebinding
 * page in this machine's own browser: such a page reaches 127.0.0.1 under a
 * hostname it controls, and without the check it could drive the signing
 * proxy, which holds this app's credentials. local-data-server makes the same
 * check; starkeep-core's `apps/local-data-server/loopback-host.ts` explains
 * why. A request with no `Host` did not come from a browser and passes.
 */
const LISTEN_HOST = "127.0.0.1";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const lower = host.trim().toLowerCase();
  const end = lower.startsWith("[") ? lower.indexOf("]") + 1 : lower.indexOf(":");
  return LOOPBACK_HOSTNAMES.has(end > 0 ? lower.slice(0, end) : lower);
}

/**
 * The `Host` check does not stop a page on another site from sending this
 * server a blind `no-cors` POST to `127.0.0.1`: its `Host` is loopback, and no
 * preflight runs for a `text/plain` body. Every route that signs, the proxy
 * and any route of the app's own, would sign it. `Sec-Fetch-Site` is the
 * browser's verdict on where the request came from. `same-site` counts as
 * another site, because every port on one loopback address is one site. A
 * request without the header came from no browser page and passes.
 *
 * A `GET` or `HEAD` navigation from another site passes, so admin-web's Open
 * link still works: following a link writes nothing, and the page that sent
 * the browser here cannot read the answer. A form POST is a navigation too,
 * and it is refused. `createDataProxyHandler` makes the same check for the
 * proxy alone; this one covers every route.
 */
function fromAnotherSite(
  site: string | undefined,
  mode: string | undefined,
  method: string,
): boolean {
  if (site !== "cross-site" && site !== "same-site") return false;
  return !(mode === "navigate" && (method === "GET" || method === "HEAD"));
}

const local = new Hono();

local.use("*", async (c, next) => {
  if (!isLoopbackHost(c.req.header("host"))) {
    return c.text("This app answers only on a loopback address.", 403);
  }
  if (
    fromAnotherSite(c.req.header("sec-fetch-site"), c.req.header("sec-fetch-mode"), c.req.method)
  ) {
    return c.text("This app refuses requests from other sites.", 403);
  }
  await next();
});

// Ahead of the app's routes, where the cloud adapter serves static files.
local.use("*", serveStatic(staticOptions(new URL("../../dist/", import.meta.url))));

local.all("*", (c) => app.fetch(c.req.raw));

function portFromArgv(argv: string[]): number {
  const at = argv.indexOf("--port");
  const value = at >= 0 ? Number(argv[at + 1]) : Number(process.env.PORT);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("The example app needs a port: --port <n>. admin-web passes one.");
  }
  return value;
}

const port = portFromArgv(process.argv.slice(2));

serve({ fetch: local.fetch, port, hostname: LISTEN_HOST }, () => {
  console.log(`example-app listening on http://127.0.0.1:${port}`);
});
