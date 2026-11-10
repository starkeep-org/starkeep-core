/**
 * The Hono integration: the base-path contract and the origin gate.
 *
 * The contract is the reason this file exists. `createWebAppHandler` hands an
 * upstream the request as the origin saw it plus the app-relative path, and a
 * router matches on the request's own pathname — so something has to reconcile
 * the two, and settled wrongly it is wrong in every app identically and
 * invisibly until a cloud install. `honoUpstream` settles it by rewriting the
 * URL, which is what lets an app route be written `/api/records` and match on
 * both surfaces.
 *
 * Hono is a devDependency here rather than an import of the module under test:
 * the integration is structural on purpose, and a real Hono app is what proves
 * the structure is the one Hono actually has.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  appBasePath,
  honoOriginGate,
  honoUpstream,
  rewritePath,
  serveStatic,
} from "../src/hono.js";
import { createWebAppHandler, type ApiGatewayV2Event } from "../src/web.js";

const BASE = "/apps/probe";

afterEach(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  delete process.env.STARKEEP_APP_BASE_PATH;
});

function event(rawPath: string, over: Partial<ApiGatewayV2Event> = {}): ApiGatewayV2Event {
  return {
    rawPath,
    headers: { host: "probe.example.com" },
    requestContext: { http: { method: "GET" } },
    ...over,
  };
}

/** An app whose routes name no mount — which is the property under test. */
function testApp() {
  const app = new Hono();
  app.get("/", (c) => c.text("shell"));
  app.get("/api/records", (c) => c.text(`records ${new URL(c.req.url).searchParams.get("limit")}`));
  app.get("/study/:deckId", (c) => c.text(`deck ${c.req.param("deckId")}`));
  app.post("/api/echo", async (c) => c.text(`echo ${await c.req.text()}`));
  app.notFound((c) => c.text(`no route for ${c.req.path}`, 404));
  return app;
}

describe("honoUpstream — the mount prefix never reaches app code", () => {
  async function handlerFor(app: ReturnType<typeof testApp>, basePath = BASE) {
    return createWebAppHandler({
      basePath,
      requestUpstream: Promise.resolve({ handler: honoUpstream(app) }),
    });
  }

  it("routes a mounted path against the app-relative route", async () => {
    const handler = await handlerFor(testApp());
    expect((await handler(event(`${BASE}/api/records`))).body).toBe("records null");
  });

  it("routes the same app unmounted, with no change to the app", async () => {
    const handler = await handlerFor(testApp(), "");
    expect((await handler(event("/api/records"))).body).toBe("records null");
  });

  it("answers the app root in both spellings the platform can produce", async () => {
    const handler = await handlerFor(testApp());
    for (const rawPath of [BASE, `${BASE}/`]) {
      expect((await handler(event(rawPath))).body, rawPath).toBe("shell");
    }
  });

  it("keeps the query string", async () => {
    const handler = await handlerFor(testApp());
    const res = await handler(event(`${BASE}/api/records`, { rawQueryString: "limit=5" }));
    expect(res.body).toBe("records 5");
  });

  it("carries a request body through the rewrite", async () => {
    // The rewrite builds a new Request, and undici refuses an init carrying a
    // body without `duplex`. A POST is the whole write half of every app.
    const handler = await handlerFor(testApp());
    const res = await handler(
      event(`${BASE}/api/echo`, {
        requestContext: { http: { method: "POST" } },
        body: "hello",
      }),
    );
    expect(res.body).toBe("echo hello");
  });

  it("decodes a percent-encoded dynamic segment", async () => {
    // Memo's deck ids contain colons, and every deck once reported "Deck not
    // found" because the segment arrived encoded. Photos has four `[id]` routes
    // exposed to the same class of bug.
    const handler = await handlerFor(testApp());
    const res = await handler(event(`${BASE}/study/${encodeURIComponent("deck:abc")}`));
    expect(res.body).toBe("deck deck:abc");
  });

  it("reports an unmatched path app-relative, not mount-relative", async () => {
    const handler = await handlerFor(testApp());
    const res = await handler(event(`${BASE}/nope`));
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("no route for /nope");
  });

  it("passes the request through untouched when there is no prefix to strip", async () => {
    const request = new Request("http://probe.example.com/api/records");
    expect(rewritePath(request, "/api/records")).toBe(request);
  });

  it("keeps the origin on the rewritten request, so an app can still build a URL", async () => {
    const request = new Request("https://probe.example.com/apps/probe/settings");
    const rewritten = rewritePath(request, "/settings");
    expect(rewritten.url).toBe("https://probe.example.com/settings");
  });
});

describe("appBasePath — where an app reads the mount when it needs one", () => {
  it("is empty when the platform has not mounted the app", () => {
    expect(appBasePath()).toBe("");
  });

  it("is what the installer wrote on the Lambda", () => {
    process.env.STARKEEP_APP_BASE_PATH = "/apps/photos";
    expect(appBasePath()).toBe("/apps/photos");
  });

  it("drops a trailing slash, so a joined path never doubles it", () => {
    process.env.STARKEEP_APP_BASE_PATH = "/apps/photos/";
    expect(appBasePath()).toBe("/apps/photos");
  });
});

describe("honoOriginGate", () => {
  async function gatedApp() {
    const app = new Hono();
    app.use(
      "*",
      honoOriginGate({ publicPaths: ["/", "/_immutable/*", "/sign-in"], signInPath: "/sign-in" }),
    );
    app.get("/", (c) => c.text("shell"));
    app.get("/sign-in", (c) => c.text("sign in"));
    app.get("/api/local-data/records", (c) => c.text("records"));
    return createWebAppHandler({
      basePath: BASE,
      requestUpstream: Promise.resolve({ handler: honoUpstream(app) }),
    });
  }

  it("refuses an undeclared path in cloud mode", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    const res = await (
      await gatedApp()
    )(event(`${BASE}/api/local-data/records`, { headers: { "sec-fetch-dest": "empty" } }));
    expect(res.statusCode).toBe(401);
  });

  /** A gated app with one private route, mounted under `BASE`. */
  async function gatedNavigationApp(gateOpts: Record<string, unknown> = {}) {
    const app = new Hono();
    app.use(
      "*",
      honoOriginGate({ publicPaths: ["/sign-in"], signInPath: "/sign-in", ...gateOpts }),
    );
    app.get("/settings", (c) => c.text("settings"));
    return createWebAppHandler({
      basePath: BASE,
      requestUpstream: Promise.resolve({ handler: honoUpstream(app) }),
    });
  }

  const navigation = (path: string) =>
    event(path, { headers: { "sec-fetch-dest": "document", host: "probe.example.com" } });

  it("redirects a navigation to the app's own sign-in page, not the origin's", async () => {
    // `honoUpstream` strips the mount before the gate matches, so the pathname
    // it judges is app-relative and `publicPaths` is written that way. The
    // `Location` is not: a browser resolves it against the distribution, where
    // `/sign-in` belongs to nobody and the app's is at `/apps/probe/sign-in`.
    // The gate reads the mount from `STARKEEP_APP_BASE_PATH`, which is what the
    // installer writes on the Lambda.
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    process.env.STARKEEP_APP_BASE_PATH = BASE;
    const res = await (await gatedNavigationApp())(navigation(`${BASE}/settings`));
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe(`https://probe.example.com${BASE}/sign-in`);
  });

  it("redirects to the origin root when there is no mount", async () => {
    // An app served at its own origin. The same code path, with nothing to
    // prefix — which is what makes the default safe to apply unconditionally.
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    const app = new Hono();
    app.use("*", honoOriginGate({ publicPaths: ["/sign-in"], signInPath: "/sign-in" }));
    app.get("/settings", (c) => c.text("settings"));
    const handler = await createWebAppHandler({
      basePath: "",
      requestUpstream: Promise.resolve({ handler: honoUpstream(app) }),
    });
    const res = await handler(navigation("/settings"));
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("https://probe.example.com/sign-in");
  });

  it("lets an explicit basePath override the mount it reads from the environment", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    process.env.STARKEEP_APP_BASE_PATH = BASE;
    const res = await (
      await gatedNavigationApp({ basePath: "/elsewhere" })
    )(navigation(`${BASE}/settings`));
    expect(res.headers["location"]).toBe("https://probe.example.com/elsewhere/sign-in");
  });

  it("lets a declared public path through", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    expect((await (await gatedApp())(event(BASE))).body).toBe("shell");
  });

  it("lets a request carrying a session cookie through to the real gate", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    const res = await (
      await gatedApp()
    )(event(`${BASE}/api/local-data/records`, { cookies: ["sk_session=abc"] }));
    expect(res.body).toBe("records");
  });

  it("is inert on the local surface — local-first means no sign-in on local data", async () => {
    const res = await (await gatedApp())(event(`${BASE}/api/local-data/records`));
    expect(res.body).toBe("records");
  });
});

describe("serveStatic — the local surface answers static files as the cloud does", () => {
  let dir: string;
  const options = () => ({
    assetsDir: dir,
    staticPaths: ["/_immutable/*", "/_static/*", "/favicon.ico"],
    immutablePaths: ["/_immutable/*"],
    shellPaths: ["/", "/settings"],
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "starkeep-serve-static-"));
    mkdirSync(join(dir, "_immutable"), { recursive: true });
    mkdirSync(join(dir, "_static"), { recursive: true });
    writeFileSync(join(dir, "_immutable", "app.1a2b3c.js"), "console.log(1)\n");
    writeFileSync(join(dir, "_static", "canvaskit.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    writeFileSync(join(dir, "favicon.ico"), Buffer.from([0x00, 0x00, 0x01, 0x00]));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>shell</title>\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function localApp() {
    const app = new Hono();
    app.use("*", serveStatic(options()));
    app.get("/api/ping", (c) => c.text("pong"));
    return app;
  }

  it("serves a hashed file forever-cached and an un-hashed one revalidated", async () => {
    const app = localApp();
    const hashed = await app.request("/_immutable/app.1a2b3c.js");
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const wasm = await app.request("/_static/canvaskit.wasm");
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(wasm.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("answers a client route with the shell", async () => {
    const res = await localApp().request("/settings");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<title>shell</title>");
  });

  it("hands every other path to the app's routes", async () => {
    expect(await (await localApp().request("/api/ping")).text()).toBe("pong");
  });

  it("answers a matching revalidation with 304", async () => {
    const app = localApp();
    const etag = (await app.request("/_static/canvaskit.wasm")).headers.get("etag")!;
    const again = await app.request("/_static/canvaskit.wasm", {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  it("matches the cloud adapter header for header", async () => {
    const local = localApp();
    const cloud = await createWebAppHandler({
      basePath: BASE,
      ...options(),
      requestUpstream: Promise.resolve({ handler: honoUpstream(new Hono()) }),
    });
    for (const path of [
      "/_immutable/app.1a2b3c.js",
      "/_static/canvaskit.wasm",
      "/favicon.ico",
      "/",
    ]) {
      const l = await local.request(path);
      const c = await cloud(event(`${BASE}${path === "/" ? "" : path}`));
      expect(c.statusCode).toBe(l.status);
      for (const header of ["content-type", "cache-control", "etag"]) {
        expect(c.headers[header]).toBe(l.headers.get(header));
      }
      const localBytes = Buffer.from(await l.arrayBuffer());
      const cloudBytes = Buffer.from(c.body!, c.isBase64Encoded ? "base64" : "utf8");
      expect(cloudBytes).toEqual(localBytes);
    }
  });
});
