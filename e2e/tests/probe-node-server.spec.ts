/**
 * Probe's local surface, started the way a bundler-built app is started.
 *
 * Two things are under test and they belong together.
 *
 * The harness gained a mode that starts a built Node server rather than a
 * framework's dev server, because that is what every app becomes once it leaves
 * Next behind. This is its first consumer, so the mode is exercised rather than
 * merely written.
 *
 * And Probe is now a Hono app behind `@hono/node-server` — the shape the
 * platform asks every app to take. The other specs reach Probe through the
 * admin daemon route, which proves it starts; this one talks to it directly and
 * checks the routes themselves, including the two spellings of the app root and
 * the immutable asset the cloud surface serves from disk instead.
 */

import { expect, test } from "@playwright/test";
import { startWebServer, CORE_FIXTURE_APPS_DIR } from "@starkeep/e2e";
import { join } from "node:path";

const PROBE_DIR = join(CORE_FIXTURE_APPS_DIR, "probe");
const ASSET = "/_immutable/probe.5f3a9c21.js";

let server: Awaited<ReturnType<typeof startWebServer>>;

test.beforeAll(async () => {
  server = await startWebServer({
    appDir: PROBE_DIR,
    mode: "node",
    // What the manifest's `localRun` names, and what admin-web spawns: the
    // entry point builds the bundle if it is missing, so a fresh checkout needs
    // no separate build step.
    args: ["run-local.mjs"],
    portFlag: "--port",
    readyPath: "/",
  });
});

test.afterAll(async () => {
  await server?.stop();
});

test("serves the app shell at both spellings of the root", async ({ request }) => {
  for (const path of ["/", ""]) {
    const res = await request.get(`${server.url}${path}`);
    expect(res.status(), path).toBe(200);
    expect(await res.text()).toContain("<h1>Probe</h1>");
  }
});

test("serves the immutable asset the shell references, cached forever", async ({ request }) => {
  const shell = await (await request.get(server.url)).text();
  expect(shell).toContain(`src="${ASSET}"`);

  const asset = await request.get(`${server.url}${ASSET}`);
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toContain("application/javascript");
  expect(asset.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
});

test("serves the sign-in page the session routes belong to", async ({ request }) => {
  const res = await request.get(`${server.url}/sign-in`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("Sign in");
});

test("answers an unrouted path app-relative, with no mount prefix in it", async ({ request }) => {
  // The local surface has no mount, so this also pins that the app's own router
  // never sees one: the same assertion holds in the cloud, where the adapter
  // strips `/apps/probe` before the app is reached.
  const res = await request.get(`${server.url}/no-such-route`);
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ error: "Probe has no route for /no-such-route" });
});

test("leaves the origin gate inert on the local surface", async ({ request }) => {
  // `/api/local-data/*` is not a declared public path. In the cloud the gate
  // refuses it without a session cookie; locally the browser, the data and the
  // person are all on one machine, so it must answer — anything else breaks the
  // local-first guarantee. It answers 503 here because no app is installed in
  // this stack's data server, which is a data-plane answer, not a refusal.
  const res = await request.get(`${server.url}/api/local-data/data/records?limit=1`);
  expect([200, 500, 502, 503]).toContain(res.status());
  expect(res.status()).not.toBe(401);
});
