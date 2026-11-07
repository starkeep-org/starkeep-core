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

const local = new Hono();

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

serve({ fetch: local.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`example-app listening on http://127.0.0.1:${port}`);
});
