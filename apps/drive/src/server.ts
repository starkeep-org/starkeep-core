/**
 * Drive's server, and the process admin-web's Dashboard actually starts.
 *
 * What changed with the framework is problem 3 of the migration plan: Drive was
 * spawned as `next dev`, so the operator's Drive was a development server
 * compiling on demand and running a development build of React. This serves
 * `vite build`'s output, and `--dev` is the opt-in development mode rather than
 * the only mode.
 *
 * Run as TypeScript under `tsx`, the way `apps/local-data-server` and
 * `apps/admin-web` are, rather than bundled to `dist/server.js`. Drive carries
 * no manifest, installs nothing and never reaches Lambda; it only ever runs
 * from this checkout on the operator's own machine, with `node_modules`
 * present. A server bundle would be apparatus with no deployment behind it. The
 * *browser* half is a real build.
 *
 * The port comes from `STARKEEP_DRIVE_PORT`, which is the same variable
 * `admin-web/src/lib/exec-commands.ts` reads to decide where to probe. Drive is
 * spawned as admin-web's child and inherits its environment, so the two cannot
 * disagree — and `admin-web/__tests__/exec-commands.test.ts` holds the pair.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { api } from "./api";
import { isFile, isServerPath, isClientRoute, resolveClientRequest, PKG_DIR, SHELL } from "./client-serving";

export const DEFAULT_PORT = 9830;

function portFromArgv(argv: string[]): number {
  const at = argv.findIndex((a) => a === "--port" || a === "-p");
  const value =
    at >= 0 ? Number(argv[at + 1]) : Number(process.env.STARKEEP_DRIVE_PORT ?? DEFAULT_PORT);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("drive needs a port: --port <n>, or STARKEEP_DRIVE_PORT");
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dev = argv.includes("--dev");
  const port = portFromArgv(argv);

  // Self-healing: Drive is started from admin-web's Dashboard by an operator
  // who never ran a build step, and a server that answered 503 there would read
  // as a platform failure rather than as a missing build.
  if (!dev && !isFile(SHELL)) {
    console.log("drive: dist/ is missing, running `vite build`…");
    const { build } = await import("vite");
    await build({ root: PKG_DIR });
  }

  const app = new Hono();
  app.route("/", api);
  const apiListener = getRequestListener(app.fetch);

  let client: (req: IncomingMessage, res: ServerResponse) => void;

  if (dev) {
    // Imported here rather than at the top: Vite belongs to the browser half
    // and has no business being loaded by a production start.
    const { createServer: createViteServer } = await import("vite");
    // `appType: "custom"`, not `"spa"`: Vite's SPA fallback answers *every*
    // unmatched path with the shell, which would make an undeclared path work
    // in development and 404 in a built start.
    const vite = await createViteServer({
      root: PKG_DIR,
      appType: "custom",
      server: { middlewareMode: true },
    });
    client = (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (!isClientRoute(pathname)) {
        // Vite owns the module graph — `/src/main.tsx`, `/@vite/client`, the
        // pre-bundled dependencies — and 404s what it does not recognise.
        vite.middlewares(req, res, () => {
          res.statusCode = 404;
          res.end();
        });
        return;
      }
      void (async () => {
        const html = await vite.transformIndexHtml(
          req.url ?? "/",
          await readFile(join(PKG_DIR, "index.html"), "utf8"),
        );
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.end(html);
      })();
    };
  } else {
    client = getRequestListener(async (request) => {
      const pathname = new URL(request.url).pathname;
      const answer = resolveClientRequest(pathname);
      if (answer.kind === "notFound") {
        return Response.json({ error: `Drive has no route for ${pathname}` }, { status: 404 });
      }
      const headers =
        answer.kind === "asset"
          ? { "content-type": answer.contentType, "cache-control": answer.cacheControl }
          : { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" };
      return new Response(await readFile(answer.file), { headers });
    });
  }

  // `/api/*` always goes to Hono; everything else is the client's. Splitting
  // here rather than inside the Hono app is what lets Vite own the client in
  // development without Hono having to know Vite exists.
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (isServerPath(pathname)) apiListener(req, res);
    else client(req, res);
  });

  server.listen(port, () => {
    console.log(`drive listening on http://localhost:${port}${dev ? " (dev)" : ""}`);
  });
}

void main();
