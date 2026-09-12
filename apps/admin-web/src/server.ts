/**
 * admin-web's server, and the process an operator actually starts.
 *
 * Load `@starkeep/app-client/load-env` first. It reads the repo-root `.env` /
 * `.env.local` into `process.env`, and it is the single hook that covers
 * admin-web end to end: the route handlers read `STARKEEP_DIR` from there, and
 * the daemons and CLIs admin-web spawns inherit it because they are spawned
 * without an explicit env. It was `next.config.ts`'s job and is now this file's.
 * It has to run before anything else imports a module that reads the
 * environment at load time — several route modules do.
 *
 * Run as TypeScript under `tsx`, the way `apps/local-data-server` is, rather
 * than bundled to `dist/server.js`. admin-web carries no manifest, installs
 * nothing and never reaches Lambda; it only ever runs from this checkout on the
 * operator's own machine, with `node_modules` present. A server bundle would be
 * apparatus with no deployment behind it. The *browser* half is a real build —
 * `vite build` emits `dist/index.html` and content-hashed assets, and what this
 * serves in production is that output rather than anything compiled on demand.
 *
 * Two modes, chosen explicitly by `--dev` rather than sniffed:
 *
 *   - `--dev` mounts Vite in middleware mode, so the client is transformed on
 *     request and hot-reloads.
 *   - Without it, `dist/` is served from disk, and every client route is
 *     answered with `dist/index.html`.
 */

import "@starkeep/app-client/load-env";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { api } from "./api";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(PKG_DIR, "dist");

function portFromArgv(argv: string[]): number {
  const at = argv.indexOf("--port");
  const value = at >= 0 ? Number(argv[at + 1]) : Number(process.env.STARKEEP_ADMIN_PORT ?? 3000);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("admin-web needs a port: --port <n>, or STARKEEP_ADMIN_PORT");
  }
  return value;
}

const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the built client.
 *
 * Content-hashed output under `/_immutable/` is cacheable forever; the shell and
 * everything else must revalidate, because the shell is the one file whose
 * contents change while its name does not. The same split the platform's web
 * adapter applies to a deployed app, which is why the prefix matches.
 */
function serveBuiltClient(app: Hono): void {
  app.get("*", async (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    const candidate = join(DIST_DIR, normalize(pathname));
    const isAsset =
      candidate !== DIST_DIR &&
      candidate.startsWith(DIST_DIR + sep) &&
      pathname !== "/" &&
      existsSync(candidate);

    // A client route, or the root: the SPA shell answers it. This is what makes
    // react-router's routes reachable by a reload or a pasted URL rather than
    // only by an in-page navigation.
    const file = isAsset ? candidate : join(DIST_DIR, "index.html");
    if (!existsSync(file)) {
      return c.text(
        `admin-web has no build to serve (${DIST_DIR} is missing or empty). ` +
          `Run \`pnpm --filter admin-web build\`, or start with --dev.`,
        503,
      );
    }

    const dot = file.lastIndexOf(".");
    const type = MIME[file.slice(dot).toLowerCase()] ?? "application/octet-stream";
    return new Response(await readFile(file), {
      headers: {
        "content-type": type,
        "cache-control": pathname.startsWith("/_immutable/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dev = argv.includes("--dev");
  const port = portFromArgv(argv);

  const app = new Hono();
  app.route("/", api);

  let handleRest: (req: IncomingMessage, res: ServerResponse) => void;

  if (dev) {
    // Imported here, not at the top: Vite is a devDependency of the browser
    // half and has no business being loaded by a production start.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: PKG_DIR,
      appType: "spa",
      server: { middlewareMode: true },
    });
    handleRest = (req, res) => vite.middlewares(req, res, () => res.end());
  } else {
    serveBuiltClient(app);
    const listener = getRequestListener(app.fetch);
    handleRest = listener;
  }

  // `/api/*` always goes to Hono; everything else is the client's. Splitting
  // here rather than inside the Hono app is what lets Vite own the client in
  // development without Hono having to know Vite exists.
  const apiListener = getRequestListener(app.fetch);
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/")) apiListener(req, res);
    else handleRest(req, res);
  });

  server.listen(port, () => {
    console.log(`admin-web listening on http://localhost:${port}${dev ? " (dev)" : ""}`);
  });
}

void main();
