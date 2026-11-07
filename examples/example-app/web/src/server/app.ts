/**
 * The example app's server half: one Hono app that both surfaces run.
 *
 * `local.ts` serves it under `@hono/node-server` on the operator's computer,
 * and `cloud.ts` hands it to the platform's web adapter as a Lambda. The routes
 * are the same on both, so a difference between the surfaces is the platform's.
 *
 * The server half is small on purpose. Every data operation the page performs
 * goes through one route, the signing proxy at `/api/local-data/*`, which adds
 * the app's credentials and forwards the request to whichever data server the
 * surface has. Sessions, signing and the origin gate all come from
 * `@starkeep/app-client`, so the example shows how an app uses the platform's
 * library rather than reimplementing it.
 *
 * **Every route is written app-relative.** In the cloud the platform mounts the
 * app at `/apps/example-app`, and `honoUpstream` strips that prefix before Hono
 * routes the request. The sign-in page's links are the one place that needs the
 * mount, and they read it from `appBasePath()`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { createSessionRoutes, SIGN_IN_START_PATH } from "@starkeep/app-client/auth";
import {
  createDataProxyHandler,
  createRuntimeConfigHandler,
  sessionAuth,
  starkeepDir,
} from "@starkeep/app-client";
import { appBasePath, honoOriginGate } from "@starkeep/app-client/hono";
import { APP_ID } from "@example-app/common";
import manifest from "../../../starkeep.manifest.json" with { type: "json" };

if (manifest.id !== APP_ID) {
  throw new Error(
    `starkeep.manifest.json names ${manifest.id}; @example-app/common names ${APP_ID}`,
  );
}
const staticHandler = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!staticHandler) throw new Error("the manifest has no `static` compute handler");

const sessionRoutes = createSessionRoutes({ appId: APP_ID });

// The proxy holds the app's credentials, so it states who may reach it. On the
// local surface the browser, the data and the person share one computer, which
// is the platform's local-first guarantee; in the cloud the session decides.
const proxy = createDataProxyHandler({ appId: APP_ID, endUserAuth: sessionAuth() });

export const app = new Hono();

// Deny by default, over the manifest's own `publicPaths`. Inert on the local
// surface; in the cloud the gateway's session authorizer refuses an anonymous
// request first, and this gate is the one an app served elsewhere would keep.
app.use(
  "*",
  honoOriginGate({
    publicPaths: staticHandler.publicPaths,
    signInPath: "/sign-in",
    basePath: appBasePath(),
  }),
);

// Which surface this is, and the cloud ids the browser needs. Every field is
// empty on the local surface.
app.get("/starkeep-runtime-config", createRuntimeConfigHandler());

// Session probe, sign-out and refresh, straight from the platform library.
// Both spellings, because `GET /api/session` is the signed-in probe and a
// router's `*` does not match the prefix itself.
const session = (c: { req: { raw: Request; path: string; method: string } }) => {
  const action = c.req.path.slice("/api/session".length).split("/").filter(Boolean);
  const ctx = { params: Promise.resolve({ action }) };
  if (c.req.method === "POST") return sessionRoutes.POST(c.req.raw, ctx);
  if (c.req.method === "GET") return sessionRoutes.GET(c.req.raw, ctx);
  return Response.json({ error: "Method not allowed" }, { status: 405 });
};
app.all("/api/session", session);
app.all("/api/session/*", session);

// The sign-in page: one button to the platform's own sign-in page. The password
// goes to the managed login page, never to this app.
app.get("/sign-in", () => {
  const base = appBasePath();
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Example App: sign in</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
<h1>Example App</h1>
<form method="get" action="${SIGN_IN_START_PATH}">
  <input type="hidden" name="app" value="${APP_ID}">
  <input type="hidden" name="return" value="${base}/">
  <button type="submit">Sign in</button>
</form>
</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
});

// The signing proxy: the browser's only route to the data plane, and the only
// place the app's credentials are used.
app.all("/api/local-data/*", (c) => {
  const path = c.req.path.slice("/api/local-data/".length).split("/").filter(Boolean);
  return proxy(c.req.raw, { params: Promise.resolve({ path }) });
});

// The cloud address public links live under, for the local surface. A computer
// signed in to a cloud records it in `~/.starkeep/config.json`, as Drive reads
// it. The cloud surface answers null, because the page's own origin is the
// cloud's address there.
app.get("/api/cloud-address", () => {
  if (process.env.STARKEEP_APP_CLIENT_MODE === "cloud") return Response.json({ url: null });
  try {
    const config = JSON.parse(readFileSync(join(starkeepDir(), "config.json"), "utf8")) as {
      publicBaseUrl?: unknown;
      apiGatewayUrl?: unknown;
    };
    const url = [config.publicBaseUrl, config.apiGatewayUrl].find(
      (v): v is string => typeof v === "string" && v.startsWith("https://"),
    );
    return Response.json({ url: url ? url.replace(/\/+$/, "") : null });
  } catch {
    return Response.json({ url: null });
  }
});

app.notFound((c) =>
  Response.json({ error: `The example app has no route for ${c.req.path}` }, { status: 404 }),
);
