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
 * for a local install, and `static-handler.ts` adapts it to an API Gateway v2
 * Lambda event for a cloud install. The suites therefore exercise the same app
 * code on both tiers, and a divergence between the two surfaces is the
 * platform's, not the fixture's.
 *
 * Everything session- and signing-related comes from `@starkeep/app-client`
 * rather than being reimplemented here. That is the point: an app author is
 * meant to get end-user auth and HMAC signing from the platform, so the fixture
 * consumes them the way an app is supposed to and the suites test the library
 * an app would actually use.
 */

import { createSessionRoutes } from "@starkeep/app-client/auth";
import { createNextProxyHandler, sessionAuth } from "@starkeep/app-client";

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

/**
 * A content-hashed asset path, so the platform's `/apps/*\/_next/static/*`
 * CloudFront behavior has something immutable to cache. The `_next/static`
 * spelling is the platform's cache-behavior convention rather than a Next.js
 * artifact — Probe uses no framework at all.
 */
const ASSET_NAME = "probe.5f3a9c21.js";

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
 * The shell's script, served as the immutable asset.
 *
 * Uploading is the one flow that differs by surface, and the difference is not
 * cosmetic. In the cloud the presigned URL points at S3 and the browser PUTs to
 * it directly — which is the only place anything exercises S3's CORS
 * configuration on a real presigned PUT. Locally the presign endpoint hands
 * back a loopback URL on the data server's own origin, which a page served from
 * the app's origin cannot PUT to, so the upload goes through the app's own
 * server instead. Both paths end in the same `POST /data/records`.
 */
function assetScript(): string {
  return `(() => {
const { base, cloud } = window.__PROBE__;
const api = base + "/api/local-data";
const statusEl = document.getElementById("status");
const grid = document.getElementById("grid");

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function render() {
  const res = await fetch(api + "/data/records?limit=200&include=metadata");
  if (!res.ok) { statusEl.textContent = "Data server GET /data/records → " + res.status; return; }
  const { records } = await res.json();
  grid.replaceChildren();
  for (const r of records) {
    if (!r.original_filename) continue;
    const img = document.createElement("img");
    img.alt = r.original_filename;
    img.width = 64;
    const u = await fetch(api + "/data/records/" + r.id + "/file-url");
    if (u.ok) img.src = (await u.json()).url;
    grid.appendChild(img);
  }
}

async function upload(file) {
  const buf = await file.arrayBuffer();
  const contentHash = await sha256Hex(buf);
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  const key = "shared/image/" + contentHash.slice(0, 2) + "/" + contentHash;

  if (cloud) {
    const p = await fetch(api + "/files/presign", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, contentType: type, intent: "instant" }),
    });
    if (!p.ok) { statusEl.textContent = "presign → " + p.status; return; }
    const presign = await p.json();
    const headers = { "Content-Type": type };
    // Mandatory when present: they are inside the signature, so dropping one
    // fails the PUT rather than storing something unverified.
    if (presign.checksumSha256) headers["x-amz-checksum-sha256"] = presign.checksumSha256;
    if (presign.storageClass) headers["x-amz-storage-class"] = presign.storageClass;
    if (presign.tagging && Object.keys(presign.tagging).length) {
      headers["x-amz-tagging"] = Object.entries(presign.tagging)
        .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
    }
    const put = await fetch(presign.url, { method: "PUT", headers, body: buf });
    if (!put.ok) { statusEl.textContent = "S3 PUT → " + put.status; return; }
  } else {
    const up = await fetch(base + "/api/upload?type=" + encodeURIComponent(type), {
      method: "PUT", headers: { "Content-Type": type }, body: buf,
    });
    if (!up.ok) { statusEl.textContent = "upload → " + up.status; return; }
  }

  const reg = await fetch(api + "/data/records", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type, contentType: type, contentHash, sizeBytes: buf.byteLength, fileName: file.name,
    }),
  });
  if (!reg.ok) { statusEl.textContent = "register → " + reg.status; return; }
  const body = await reg.json();
  statusEl.textContent = body.deduped
    ? file.name + " is already in your library"
    : "Uploaded " + file.name;
  await render();
}

document.getElementById("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) upload(file);
});
render();
})();`;
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
