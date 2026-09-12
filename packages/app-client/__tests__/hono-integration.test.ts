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
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { appBasePath, honoOriginGate, honoUpstream, rewritePath } from "../src/hono.js";
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
    const res = await (await gatedApp())(
      event(`${BASE}/api/local-data/records`, { headers: { "sec-fetch-dest": "empty" } }),
    );
    expect(res.statusCode).toBe(401);
  });

  it("redirects a navigation to the mounted sign-in page", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    const app = new Hono();
    app.use(
      "*",
      honoOriginGate({
        publicPaths: ["/sign-in"],
        signInPath: "/sign-in",
        // The gate sees an app-relative pathname because honoUpstream rewrote
        // it, so the redirect target needs the mount back.
        basePath: "",
      }),
    );
    app.get("/settings", (c) => c.text("settings"));
    const handler = await createWebAppHandler({
      basePath: BASE,
      requestUpstream: Promise.resolve({ handler: honoUpstream(app) }),
    });
    const res = await handler(
      event(`${BASE}/settings`, { headers: { "sec-fetch-dest": "document", host: "probe.example.com" } }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("https://probe.example.com/sign-in");
  });

  it("lets a declared public path through", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    expect((await (await gatedApp())(event(BASE))).body).toBe("shell");
  });

  it("lets a request carrying a session cookie through to the real gate", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    const res = await (await gatedApp())(
      event(`${BASE}/api/local-data/records`, { cookies: ["sk_session=abc"] }),
    );
    expect(res.body).toBe("records");
  });

  it("is inert on the local surface — local-first means no sign-in on local data", async () => {
    const res = await (await gatedApp())(event(`${BASE}/api/local-data/records`));
    expect(res.body).toBe("records");
  });
});
