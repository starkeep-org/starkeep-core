/**
 * The local surface: what the manifest's `localRun` starts.
 *
 * admin-web runs `pnpm start` in this folder and passes the port it chose on
 * `--port`. The `start` script builds the browser half first, so the server
 * never serves stale browser code, then runs this file.
 *
 * This file adds the one thing the cloud's web adapter does that the shared
 * Hono app does not: serving the built browser half from `dist/`. Everything
 * else falls through to `app.ts`.
 */

import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { app } from "./app.js";

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

async function fromDist(relative: string, cacheControl: string): Promise<Response | null> {
  const file = resolve(DIST, relative);
  // A `..` that climbs out of the build must not be read, whatever it names.
  if (!file.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep)) return null;
  try {
    const body = await readFile(file);
    return new Response(body, {
      headers: {
        "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": cacheControl,
      },
    });
  } catch {
    return null;
  }
}

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

// Content-hashed output is cacheable forever, the same split the cloud applies.
local.get("/_immutable/*", async (c) => {
  const answer = await fromDist(c.req.path.slice(1), "public, max-age=31536000, immutable");
  return answer ?? c.notFound();
});

// The shell must revalidate: it is the one file whose content changes while its
// name does not.
local.get("/", async (c) => {
  const answer = await fromDist("index.html", "no-cache");
  return answer ?? c.text("dist/index.html is missing: run `pnpm build` first.", 500);
});

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
