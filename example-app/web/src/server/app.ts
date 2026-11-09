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
import { echo } from "./echo.js";
import manifest from "../../../starkeep.manifest.json" with { type: "json" };

if (manifest.id !== APP_ID) {
  throw new Error(
    `starkeep.manifest.json names ${manifest.id}; @example-app/common names ${APP_ID}`,
  );
}
const staticHandler = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!staticHandler?.publicPaths) {
  throw new Error("the manifest has no `static` compute handler with `publicPaths`");
}
const publicPaths = staticHandler.publicPaths;

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
    publicPaths,
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

/**
 * The sign-in page's first move in the cloud: trade a live session for a fresh
 * token, without asking anyone anything.
 *
 * `sk_token` lasts about an hour and `sk_session` lasts weeks. The CloudFront
 * redirect and the gateway both read `sk_token`, so an hour after the last
 * page load a person who never signed out lands here. `POST
 * /api/session/refresh` mints a new `sk_token` from `sk_session`, and the page
 * goes back to the app. A person with no session sees the button at once and
 * the refresh fails quietly.
 *
 * One bounce, not a loop: if the app sends the browser straight back here
 * after a refresh succeeded, the second visit within 15 seconds shows the
 * button rather than refreshing again.
 */
function restoreSessionScript(base: string): string {
  return `<script>
(async () => {
  const key = "example-app:signInBounce";
  try {
    if (Date.now() - Number(sessionStorage.getItem(key)) < 15000) return;
  } catch {}
  try {
    const res = await fetch("${base}/api/session/refresh", {
      method: "POST",
      credentials: "same-origin",
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.signedIn) {
      try { sessionStorage.setItem(key, String(Date.now())); } catch {}
      location.replace("${base}/");
    }
  } catch {}
})();
</script>`;
}

// The sign-in page: one button to the platform's own sign-in page. The password
// goes to the managed login page, never to this app. In the cloud the page
// first tries to restore a live session; locally nothing sends anyone here.
app.get("/sign-in", () => {
  const base = appBasePath();
  const restore =
    process.env.STARKEEP_APP_CLIENT_MODE === "cloud" ? restoreSessionScript(base) : "";
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
${restore}
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

// The JWT-gated route, on the local surface. In the cloud the gateway sends
// `POST /api/echo` to the manifest's `api` handler instead, so this line never
// runs there. See `echo.ts`.
app.post("/api/echo", (c) => echo(c.req.raw));

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
