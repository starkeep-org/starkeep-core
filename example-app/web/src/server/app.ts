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
 * routes the request. The origin gate's sign-in redirect is the one place that
 * needs the mount, and it reads it from `appBasePath()`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { createSessionRoutes, createSignInPage } from "@starkeep/app-client/auth";
import {
  createDataProxyHandler,
  createRuntimeConfigHandler,
  sessionAuth,
  starkeepDir,
} from "@starkeep/app-client";
import { appBasePath, honoOriginGate } from "@starkeep/app-client/hono";
import { APP_ID } from "@example-app/common";
import { echo } from "./echo.js";
import { handleMcp } from "./mcp.js";
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

// The MCP endpoint for outside clients, ahead of the origin gate below: an
// MCP client holds a delegation token, never a session cookie, so the gate
// would send it to the sign-in page. The route checks its caller itself, and
// in the cloud the gateway's delegated authorizer has checked the token
// first. See `mcp.ts`.
app.post("/mcp", (c) => handleMcp(c.req.raw));

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

// The platform's default sign-in page: one button to the managed sign-in, so
// the password never reaches this app. In the cloud the page first tries to
// restore a live session through the session routes above. Locally nothing
// sends anyone here.
const signInPage = createSignInPage({ appId: APP_ID, appName: "Example App" });
app.get("/sign-in", () => signInPage());

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
