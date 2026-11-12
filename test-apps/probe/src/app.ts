/**
 * The Probe fixture app, as a Hono app.
 *
 * Probe exists so the platform's own test suites have a conforming app to
 * install, run, serve, sign in to, sync and uninstall without depending on any
 * particular real application. It is deliberately the *smallest* app that
 * touches every surface the platform offers: a served shell, a sign-in flow, a
 * signing proxy, a shared-record write path, a declared label vocabulary, an
 * app-private table, an analysis read over a snapshot of that table, and a
 * JWT-gated compute route.
 *
 * It is also the platform's worked example of the shape every Starkeep app
 * takes. The server half is a Hono app; `serve.ts` runs it under
 * `@hono/node-server` for a local install, and `static-handler.ts` hands it to
 * `createWebAppHandler` through `honoUpstream` for the cloud. The suites
 * therefore exercise the same app code on both tiers, and a divergence between
 * the two surfaces is the platform's, not the fixture's.
 *
 * **Every route here is written app-relative.** In the cloud the platform mounts
 * the app at `/apps/probe` and the Lambda sees that prefix, but `honoUpstream`
 * rewrites the request's URL to the app-relative path before Hono routes it, so
 * nothing below names the mount. The one place that still needs it, the shell's
 * script tag, emits a URL a browser will resolve, so it reads the mount from
 * `appBasePath()`. The sign-in page is the platform's `createSignInPage`, which
 * builds its own URLs.
 *
 * Everything session- and signing-related comes from `@starkeep/app-client`
 * rather than being reimplemented here. That is the point: an app author is
 * meant to get end-user auth and HMAC signing from the platform, so the fixture
 * consumes them the way an app is supposed to and the suites test the library
 * an app would actually use.
 */

import { Hono } from "hono";
import { createSessionRoutes, createSignInPage } from "@starkeep/app-client/auth";
import { createDataProxyHandler, sessionAuth } from "@starkeep/app-client";
import { appBasePath, honoOriginGate } from "@starkeep/app-client/hono";
import {
  createSnapshotSql,
  SnapshotAccessError,
  SnapshotLoadError,
} from "@starkeep/app-client/snapshot";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { ASSET_NAME, STATIC_NAME } from "./assets.js";

/** The app id, fixed to match `starkeep.manifest.json`. */
export const APP_ID = "probe";

/** Cloud mode is what the platform sets on an installed app's Lambda. */
function isCloud(): boolean {
  return process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
}

const shellHandler = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!shellHandler?.publicPaths) {
  throw new Error("probe manifest has no `static` compute handler with publicPaths");
}
const PUBLIC_PATHS: string[] = shellHandler.publicPaths;

const sessionRoutes = createSessionRoutes({ appId: APP_ID });

// The proxy holds the app's HMAC secret, so it states who may reach it.
// `allowAnonymousLocal` is left at its default: on the local surface the
// browser, the data and the person are all on one machine, which is the
// local-first guarantee the platform makes.
const proxy = createDataProxyHandler({ appId: APP_ID, endUserAuth: sessionAuth() });

// Analysis reads in SQL, over a cached copy of the app's own rows. The copy
// lives five minutes; a `freshAfter` from the browser reloads an older one, on
// whichever instance answers.
const snapshots = createSnapshotSql({
  appId: APP_ID,
  tables: manifest.infraRequirements.appSpecificSyncable.tables,
});
const NOTES_SUMMARY_SQL = `
  SELECT count(*) AS notes, coalesce(sum(length(note)), 0) AS characters
  FROM probe_notes`;
const SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

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

/**
 * The app shell.
 *
 * The upload control is labelled "Upload" and every tile carries its file name
 * as alt text, because that is what a browser-driven test can address without
 * reaching into the markup.
 */
function shellPage(base: string, cloud: boolean): string {
  return `<!doctype html>
<html><head><title>Probe</title><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${base}/_static/${STATIC_NAME}"></head>
<body>
<h1>Probe</h1>
<label>Upload<input type="file" id="file" accept="image/png,image/jpeg"></label>
<p id="status" role="status"></p>
<div id="grid"></div>
<script>window.__PROBE__ = ${JSON.stringify({ base, cloud })};</script>
<script src="${base}/_immutable/${ASSET_NAME}"></script>
</body></html>`;
}

export const app = new Hono();

// The origin gate, deny-by-default over the manifest's own `publicPaths`. It is
// inert on the local surface and redundant with the gateway's session
// authorizer in the cloud; it is mounted anyway because it is the one gate an
// app served outside the gateway would still have, and because a fixture that
// does not mount it would not prove it mounts.
app.use("*", honoOriginGate({ publicPaths: PUBLIC_PATHS, signInPath: "/sign-in" }));

// The platform's default sign-in page: one button to the managed login page,
// which takes the password, so this app never sees it.
const signInPage = createSignInPage({ appId: APP_ID, appName: "Probe" });
app.get("/sign-in", () => signInPage());

// Session probe / sign-out / refresh, straight from the platform library.
app.all("/api/session/*", (c) => {
  const action = c.req.path.slice("/api/session/".length).split("/").filter(Boolean);
  const ctx = { params: Promise.resolve({ action }) };
  if (c.req.method === "POST") return sessionRoutes.POST(c.req.raw, ctx);
  if (c.req.method === "GET") return sessionRoutes.GET(c.req.raw, ctx);
  return json({ error: "Method not allowed" }, 405);
});

// The signing proxy: the browser's only route to the data plane, and the
// only place the app's HMAC secret is used.
app.all("/api/local-data/*", (c) => {
  const segments = c.req.path.slice("/api/local-data/".length).split("/").filter(Boolean);
  return proxy(c.req.raw, { params: Promise.resolve({ path: segments }) });
});

// An analysis read: the platform's snapshot helper runs the SQL, and the answer
// carries the snapshot's load time for an "as of" label.
app.get("/api/notes-summary", async (c) => {
  const floor = Number(c.req.query("freshAfter") ?? "");
  try {
    const result = await snapshots.query(c.req.raw, {
      tables: ["probe_notes"],
      sql: NOTES_SUMMARY_SQL,
      maxAge: SNAPSHOT_MAX_AGE_MS,
      freshAfter: Number.isFinite(floor) ? floor : undefined,
    });
    const res = json({ summary: result.rows[0], loadedAt: result.loadedAt });
    if (result.setCookie) res.headers.append("Set-Cookie", result.setCookie);
    return res;
  } catch (err) {
    if (err instanceof SnapshotAccessError || err instanceof SnapshotLoadError) {
      return json({ error: err.message }, err.status);
    }
    throw err;
  }
});

// Local-surface upload relay: the server-side signed write path. See
// assetScript() for why Probe keeps it.
app.put("/api/upload", (c) => {
  if (isCloud()) return json({ error: "The upload relay is a local-surface route" }, 404);
  return relayUpload(c.req.raw);
});

app.get("/", () => html(shellPage(appBasePath(), isCloud())));

app.notFound((c) => json({ error: `Probe has no route for ${c.req.path}` }, 404));

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
