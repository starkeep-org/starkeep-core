#!/usr/bin/env node
/**
 * Load the cloud bundle the way Lambda does, and send it a few requests.
 *
 * `pnpm bundle` writes `dist.zip`, but building it proves nothing about
 * loading it: a broken top-level await, a dependency that expects `require`,
 * a JSON import esbuild failed to inline, or a missing `assets/` folder all
 * build cleanly and fail on the first cold start. This script unzips the
 * bundle into an empty folder, with no `node_modules` anywhere above it,
 * imports both entries in cloud mode, and sends each one API Gateway v2
 * events:
 *
 * - `index.handler`: the page shell, one content-hashed asset, the runtime
 *   config through the Hono app, the gate's refusal of an anonymous proxy
 *   call, and `POST /mcp` reaching its own delegation check;
 * - `api.handler`: `POST /api/echo`.
 *
 * Usage: `node scripts/bundle-smoke.mjs <dist.zip>`, or set
 * `STARKEEP_BUNDLE_OUT` as `pnpm bundle` takes it. No network and no AWS.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APP_ID = "example-app";
const BASE = `/apps/${APP_ID}`;

const zip = process.argv[2] ?? process.env.STARKEEP_BUNDLE_OUT;
if (!zip) {
  console.error("Usage: node scripts/bundle-smoke.mjs <dist.zip>");
  process.exit(1);
}

// What the platform sets on the app's Lambda. No cloud is reachable, so only
// routes that answer without one are sent.
process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
process.env.STARKEEP_APP_ID = APP_ID;
process.env.STARKEEP_APP_BASE_PATH = BASE;

/** One API Gateway v2 event, as the gateway sends it to the Lambda. */
function event(method, path, { headers = {}, body } = {}) {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    headers: { host: "cloud.example.test", "x-forwarded-proto": "https", ...headers },
    requestContext: { http: { method, path } },
    ...(body !== undefined ? { body, isBase64Encoded: false } : {}),
  };
}

const failures = [];
function check(what, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${detail}`}`);
  if (!ok) failures.push(what);
}

const dir = mkdtempSync(join(tmpdir(), "example-app-bundle-smoke-"));
try {
  execFileSync("unzip", ["-q", resolve(zip), "-d", dir], { stdio: "inherit" });
  const index = await import(pathToFileURL(join(dir, "index.mjs")).href);
  const api = await import(pathToFileURL(join(dir, "api.mjs")).href);
  check("index.mjs exports handler", typeof index.handler === "function", typeof index.handler);
  check("api.mjs exports handler", typeof api.handler === "function", typeof api.handler);

  const shell = await index.handler(event("GET", `${BASE}/`));
  const html = shell.isBase64Encoded ? Buffer.from(shell.body, "base64").toString() : shell.body;
  check("GET / answers the shell", shell.statusCode === 200, `status ${shell.statusCode}`);
  const asset = /(?:src|href)="(\/apps\/example-app\/_immutable\/[^"]+)"/.exec(html ?? "")?.[1];
  check(
    "the shell names a content-hashed asset under the mount",
    Boolean(asset),
    html?.slice(0, 200),
  );
  if (asset) {
    const res = await index.handler(event("GET", asset));
    check(`GET ${asset} answers`, res.statusCode === 200, `status ${res.statusCode}`);
    check(
      "the asset is cached as immutable",
      /immutable/.test(res.headers?.["cache-control"] ?? ""),
      res.headers?.["cache-control"],
    );
  }

  const config = await index.handler(event("GET", `${BASE}/starkeep-runtime-config`));
  check(
    "GET /starkeep-runtime-config reaches the Hono app",
    config.statusCode === 200 && /json/.test(config.headers?.["content-type"] ?? ""),
    `status ${config.statusCode}, ${config.body?.slice(0, 200)}`,
  );

  const proxy = await index.handler(
    event("GET", `${BASE}/api/local-data/data/types`, { headers: { "sec-fetch-dest": "empty" } }),
  );
  check(
    "the gate refuses an anonymous proxy call",
    proxy.statusCode === 401,
    `status ${proxy.statusCode}`,
  );

  const mcp = await index.handler(
    event("POST", `${BASE}/mcp`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  check(
    "POST /mcp reaches its own delegation check, ahead of the gate",
    mcp.statusCode === 401 && /^Bearer /.test(mcp.headers?.["www-authenticate"] ?? ""),
    `status ${mcp.statusCode}, ${JSON.stringify(mcp.headers)}`,
  );

  const echo = await api.handler(
    event("POST", `${BASE}/api/echo`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    }),
  );
  check(
    "api.handler echoes POST /api/echo",
    echo.statusCode === 200 && JSON.parse(echo.body).echo?.message === "hello",
    `status ${echo.statusCode}, ${echo.body}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`${failures.length} bundle check(s) failed.`);
  process.exit(1);
}
console.log("The bundle loads and answers.");
