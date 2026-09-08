/**
 * The Probe fixture app, as one request handler.
 *
 * Probe exists so the platform's own test suites have a conforming app to
 * install, run, serve, sign in to, sync and uninstall without depending on any
 * particular real application. It is deliberately the *smallest* app that
 * touches every surface the platform offers: a served shell, a sign-in flow, a
 * signing proxy, a shared-record write path, a declared label vocabulary, an
 * app-private table, and a JWT-gated compute route.
 *
 * Written against web `Request`/`Response` so one implementation serves both
 * surfaces the platform runs an app on: `serve.mjs` adapts it to `node:http`
 * for a local install, and in the cloud the platform's own web adapter
 * (`@starkeep/app-client/web`, wired up in `static-handler.ts`) adapts it to an
 * API Gateway v2 Lambda event. The suites therefore exercise the same app code
 * on both tiers, and a divergence between the two surfaces is the platform's,
 * not the fixture's.
 *
 * Everything session- and signing-related comes from `@starkeep/app-client`
 * rather than being reimplemented here. That is the point: an app author is
 * meant to get end-user auth and HMAC signing from the platform, so the fixture
 * consumes them the way an app is supposed to and the suites test the library
 * an app would actually use.
 */

import { createSessionRoutes } from "@starkeep/app-client/auth";
import { createNextProxyHandler, sessionAuth } from "@starkeep/app-client";
import { ASSET_NAME, assetScript } from "./assets.js";

/** The app id, fixed to match `starkeep.manifest.json`. */
export const APP_ID = "probe";

/** Cloud mode is what the platform sets on an installed app's Lambda. */
function isCloud(): boolean {
  return process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
}

/**
 * The path everything this app serves sits under. In the cloud the platform
 * mounts the app at `/apps/<appId>`, and the Lambda sees the full path; locally
 * the app owns its own origin and the prefix is empty.
 */
function basePath(): string {
  return isCloud() ? `/apps/${APP_ID}` : "";
}

const sessionRoutes = createSessionRoutes({ appId: APP_ID });

// The proxy holds the app's HMAC secret, so it states who may reach it.
// `allowAnonymousLocal` is left at its default: on the local surface the
// browser, the data and the person are all on one machine, which is the
// local-first guarantee the platform makes.
const proxy = createNextProxyHandler({ appId: APP_ID, endUserAuth: sessionAuth() });

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The sign-in page. Plain HTML and no hydration step, so it is interactive as soon as it parses. */
function signInPage(base: string): string {
  return `<!doctype html>
<html><head><title>Probe — Sign in</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
<h1>Probe</h1>
<form id="f">
  <input type="email" name="email" placeholder="Email" required>
  <input type="password" name="password" placeholder="Password" required>
  <button type="submit">Sign in</button>
  <p id="err" role="alert"></p>
</form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = e.target.email.value, password = e.target.password.value;
  const res = await fetch(${JSON.stringify(base)} + "/api/session/sign-in", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) { location.href = ${JSON.stringify(base || "/")}; return; }
  document.getElementById("err").textContent = "Sign-in failed: " + res.status;
});
</script>
</body></html>`;
}

/**
 * The app shell.
 *
 * The upload control is labelled "Upload" and every tile carries its file name
 * as alt text, because that is what a browser-driven test can address without
 * reaching into the markup.
 */
function shellPage(base: string, cloud: boolean): string {
  return `<!doctype html>
<html><head><title>Probe</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>
<h1>Probe</h1>
<label>Upload<input type="file" id="file" accept="image/png,image/jpeg"></label>
<p id="status" role="status"></p>
<div id="grid"></div>
<script>window.__PROBE__ = ${JSON.stringify({ base, cloud })};</script>
<script src="${base}/_next/static/${ASSET_NAME}"></script>
</body></html>`;
}

/**
 * Serve one request.
 *
 * `path` is the app-relative path with the platform's mount prefix already
 * stripped, so both adapters agree on what the app is being asked for.
 */
export async function handleRequest(req: Request, path: string): Promise<Response> {
  const base = basePath();
  const cloud = isCloud();

  // The immutable asset. Cached hard on purpose: the platform's CloudFront
  // behavior for this path is CachingOptimized, and an edge hit on it is what
  // the tier-3 suite asserts.
  //
  // This branch answers the local surface. In the cloud the bundle stages the
  // same bytes to disk and the web adapter serves them ahead of this handler,
  // which is what makes Probe a test of the adapter's static path rather than
  // only of its payload encoding. Both answers come from `assetScript()`, so
  // the two surfaces cannot drift.
  if (path === `/_next/static/${ASSET_NAME}`) {
    return new Response(assetScript(), {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (path === "/sign-in") return html(signInPage(base));

  // Session sign-in / sign-out / refresh, straight from the platform library.
  if (path.startsWith("/api/session/")) {
    const action = path.slice("/api/session/".length).split("/").filter(Boolean);
    const ctx = { params: Promise.resolve({ action }) };
    if (req.method === "POST") return sessionRoutes.POST(req, ctx);
    if (req.method === "GET") return sessionRoutes.GET(req, ctx);
    return json({ error: "Method not allowed" }, 405);
  }

  // The signing proxy: the browser's only route to the data plane, and the
  // only place the app's HMAC secret is used.
  if (path.startsWith("/api/local-data/")) {
    const segments = path.slice("/api/local-data/".length).split("/").filter(Boolean);
    return proxy(req, { params: Promise.resolve({ path: segments }) });
  }

  // Local-surface upload relay. See assetScript() for why the local surface
  // cannot PUT to the presigned URL from the page.
  if (path === "/api/upload" && req.method === "PUT" && !cloud) {
    return relayUpload(req);
  }

  if (path === "/" || path === "") return html(shellPage(base, cloud));

  return json({ error: `Probe has no route for ${path}` }, 404);
}

/**
 * Store bytes on the local data server and answer with what the page needs to
 * register the record. Signed with the app's own credential, so it is the same
 * authenticated write path the proxy uses.
 */
async function relayUpload(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "image/png";
  const bytes = Buffer.from(await req.arrayBuffer());
  const { loadAppCredentials, signedFetch } = await import("@starkeep/app-client");
  const creds = await loadAppCredentials(APP_ID);
  if (!creds) return json({ error: `${APP_ID} is not installed locally` }, 503);
  const res = await signedFetch(creds, `/data/files?type=${encodeURIComponent(type)}`, {
    method: "POST",
    headers: { "Content-Type": type },
    body: bytes,
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
