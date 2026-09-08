/**
 * The web adapter's six concerns, tested once for every app that adopts it.
 *
 * These used to be three copies of the same code in three apps, and the copies
 * disagreed. The fixture below is Probe-shaped on purpose — a mount prefix, a
 * content-addressed asset on disk, a sign-in that sets two cookies — because
 * Probe is the fixture the platform installs to prove its own contract, and an
 * adapter that cannot serve Probe is wrong.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWebAppHandler,
  pathCoveredBy,
  stripBasePath,
  toRequest,
  toResult,
  type ApiGatewayV2Event,
} from "../src/web.js";

const BASE = "/apps/probe";
let assetsDir: string;

beforeAll(() => {
  assetsDir = mkdtempSync(join(tmpdir(), "starkeep-web-adapter-"));
  mkdirSync(join(assetsDir, "_next", "static"), { recursive: true });
  writeFileSync(join(assetsDir, "_next", "static", "probe.5f3a9c21.js"), "console.log(1)\n");
  writeFileSync(join(assetsDir, "BUILD_ID"), "abc123");
  writeFileSync(join(assetsDir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  mkdirSync(join(assetsDir, "sub"), { recursive: true });
  writeFileSync(join(assetsDir, "..", "outside.txt"), "secret");
});

afterAll(() => {
  rmSync(assetsDir, { recursive: true, force: true });
});

function event(rawPath: string, over: Partial<ApiGatewayV2Event> = {}): ApiGatewayV2Event {
  return {
    rawPath,
    headers: { host: "probe.example.com" },
    requestContext: { http: { method: "GET" } },
    ...over,
  };
}

/** The Probe-shaped upstream: a web request handler, given the stripped path. */
function requestUpstream(seen: { path?: string; url?: string } = {}) {
  return Promise.resolve({
    handler: async (req: Request, path: string): Promise<Response> => {
      seen.path = path;
      seen.url = req.url;
      if (path === "/api/session/sign-in") {
        const headers = new Headers({ "Content-Type": "application/json" });
        headers.append("Set-Cookie", "sk_session=a; Path=/; HttpOnly");
        headers.append("Set-Cookie", "sk_token=b; Path=/; HttpOnly");
        return new Response(JSON.stringify({ ok: true, cookie: req.headers.get("cookie") }), {
          headers,
        });
      }
      return new Response(`upstream:${path}`, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
}

describe("mount prefix", () => {
  it("treats the bare prefix and its trailing-slash spelling as the app root", () => {
    expect(stripBasePath(BASE, BASE)).toBe("/");
    expect(stripBasePath(BASE, `${BASE}/`)).toBe("/");
    expect(stripBasePath(BASE, `${BASE}/sign-in`)).toBe("/sign-in");
    expect(stripBasePath("", "/sign-in")).toBe("/sign-in");
    expect(stripBasePath(BASE, "/apps/other/x")).toBeNull();
  });

  it("hands the upstream the app-relative path and the origin-facing URL", async () => {
    const seen: { path?: string; url?: string } = {};
    const handler = await createWebAppHandler({
      basePath: BASE,
      requestUpstream: requestUpstream(seen),
    });
    const res = await handler(event(`${BASE}/sign-in`));
    expect(seen.path).toBe("/sign-in");
    expect(seen.url).toBe("https://probe.example.com/apps/probe/sign-in");
    expect(res.body).toBe("upstream:/sign-in");
  });
});

describe("payload encoding", () => {
  it("rebuilds method, query and a text body", async () => {
    const req = toRequest({
      rawPath: "/apps/probe/api/echo",
      rawQueryString: "a=1&b=2",
      headers: { host: "probe.example.com", "content-type": "application/json" },
      requestContext: { http: { method: "POST" } },
      body: '{"hello":"world"}',
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://probe.example.com/apps/probe/api/echo?a=1&b=2");
    await expect(req.text()).resolves.toBe('{"hello":"world"}');
  });

  it("decodes a base64 body", async () => {
    const req = toRequest({
      rawPath: "/apps/probe/api/upload",
      requestContext: { http: { method: "PUT" } },
      body: Buffer.from([1, 2, 3]).toString("base64"),
      isBase64Encoded: true,
    });
    expect(Buffer.from(await req.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it("drops a body on GET, which Request refuses to carry", () => {
    expect(() =>
      toRequest({ rawPath: "/", requestContext: { http: { method: "GET" } }, body: "x" }),
    ).not.toThrow();
  });

  it("returns text bodies as text and everything else as base64", async () => {
    const text = await toResult(
      new Response("hi", { headers: { "content-type": "text/plain" } }),
    );
    expect(text).toMatchObject({ statusCode: 200, body: "hi" });
    expect(text.isBase64Encoded).toBeUndefined();

    const bytes = await toResult(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    expect(bytes).toMatchObject({ isBase64Encoded: true, body: "AQID" });
  });

  it("honours x-forwarded-proto", () => {
    const req = toRequest({
      rawPath: "/",
      headers: { host: "probe.local", "x-forwarded-proto": "http" },
    });
    expect(req.url).toBe("http://probe.local/");
  });
});

describe("cookies", () => {
  it("lifts the cookies array into a Cookie header inbound", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      requestUpstream: requestUpstream(),
    });
    const res = await handler(
      event(`${BASE}/api/session/sign-in`, { cookies: ["sk_session=a", "sk_token=b"] }),
    );
    expect(JSON.parse(res.body!).cookie).toBe("sk_session=a; sk_token=b");
  });

  it("splits Set-Cookie back into cookies[] so a second cookie is not lost", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      requestUpstream: requestUpstream(),
    });
    const res = await handler(event(`${BASE}/api/session/sign-in`));
    expect(res.cookies).toEqual([
      "sk_session=a; Path=/; HttpOnly",
      "sk_token=b; Path=/; HttpOnly",
    ]);
    expect(Object.keys(res.headers).map((k) => k.toLowerCase())).not.toContain("set-cookie");
  });
});

describe("static assets", () => {
  async function staticHandler(over: Record<string, unknown> = {}) {
    return createWebAppHandler({
      basePath: BASE,
      assetsDir,
      staticPaths: ["/_next/static/*", "/BUILD_ID", "/icon.png"],
      requestUpstream: requestUpstream(),
      ...over,
    });
  }

  it("serves a declared path from disk with its content type", async () => {
    const res = await (await staticHandler())(event(`${BASE}/_next/static/probe.5f3a9c21.js`));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(res.body).toBe("console.log(1)\n");
    expect(res.isBase64Encoded).toBeUndefined();
  });

  it("base64-encodes a binary asset", async () => {
    const res = await (await staticHandler())(event(`${BASE}/icon.png`));
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.isBase64Encoded).toBe(true);
    expect(Buffer.from(res.body!, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("leaves an undeclared path to the upstream even when the file exists", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      assetsDir,
      staticPaths: ["/BUILD_ID"],
      requestUpstream: requestUpstream(),
    });
    const res = await handler(event(`${BASE}/icon.png`));
    expect(res.body).toBe("upstream:/icon.png");
  });

  it("falls through to the upstream on a miss by default", async () => {
    const res = await (await staticHandler())(event(`${BASE}/_next/static/gone.js`));
    expect(res.body).toBe("upstream:/_next/static/gone.js");
  });

  it("answers 404 on a miss when the app owns the whole prefix", async () => {
    const res = await (await staticHandler({ staticMiss: "notFound" }))(
      event(`${BASE}/_next/static/gone.js`),
    );
    expect(res.statusCode).toBe(404);
  });

  it("refuses to build a handler that declares static paths with no assets dir", async () => {
    await expect(
      createWebAppHandler({
        basePath: BASE,
        staticPaths: ["/BUILD_ID"],
        requestUpstream: requestUpstream(),
      }),
    ).rejects.toThrow(/no assetsDir was given/);
  });

  it("accepts a file: URL for the assets dir", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      assetsDir: new URL(`file://${assetsDir}/`),
      staticPaths: ["/BUILD_ID"],
      requestUpstream: requestUpstream(),
    });
    // BUILD_ID carries no extension, so it is bytes rather than text — the
    // same answer the wrappers this replaces gave it.
    const res = await handler(event(`${BASE}/BUILD_ID`));
    expect(Buffer.from(res.body!, "base64").toString("utf8")).toBe("abc123");
  });
});

describe("path safety", () => {
  it("rejects a path that escapes the assets directory", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      assetsDir,
      staticPaths: ["/_next/static/*"],
      requestUpstream: requestUpstream(),
    });
    const res = await handler(event(`${BASE}/_next/static/../../../outside.txt`));
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Bad path");
  });

  it("treats a directory as a miss rather than a listing", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      assetsDir,
      staticPaths: ["/sub"],
      staticMiss: "notFound",
      requestUpstream: requestUpstream(),
    });
    expect((await handler(event(`${BASE}/sub`))).statusCode).toBe(404);
  });
});

describe("cache-control", () => {
  it("marks content-addressed assets immutable", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      assetsDir,
      staticPaths: ["/_next/static/*", "/BUILD_ID"],
      requestUpstream: requestUpstream(),
    });
    const asset = await handler(event(`${BASE}/_next/static/probe.5f3a9c21.js`));
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const buildId = await handler(event(`${BASE}/BUILD_ID`));
    expect(buildId.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
  });

  it("lets an app name its own content-addressed prefix", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      assetsDir,
      staticPaths: ["/BUILD_ID"],
      immutablePaths: ["/BUILD_ID"],
      requestUpstream: requestUpstream(),
    });
    expect((await handler(event(`${BASE}/BUILD_ID`))).headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});

describe("the event upstream", () => {
  it("passes the original event through, mount prefix intact", async () => {
    let seen: ApiGatewayV2Event | undefined;
    const handler = await createWebAppHandler({
      basePath: BASE,
      upstream: Promise.resolve({
        handler: (e: ApiGatewayV2Event) => {
          seen = e;
          return { statusCode: 200, headers: {}, body: "opennext" };
        },
      }),
    });
    const res = await handler(event(`${BASE}/deck/1`));
    expect(seen?.rawPath).toBe(`${BASE}/deck/1`);
    expect(res.body).toBe("opennext");
  });

  it("answers static assets without touching the upstream", async () => {
    let calls = 0;
    const handler = await createWebAppHandler({
      basePath: BASE,
      assetsDir,
      staticPaths: ["/BUILD_ID"],
      upstream: Promise.resolve({
        handler: () => {
          calls++;
          return { statusCode: 200, headers: {}, body: "" };
        },
      }),
    });
    await handler(event(`${BASE}/BUILD_ID`));
    expect(calls).toBe(0);
  });
});

describe("errors", () => {
  it("rethrows by default, leaving the framework's own reporting alone", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      requestUpstream: Promise.resolve({
        handler: () => {
          throw new Error("boom");
        },
      }),
    });
    await expect(handler(event(`${BASE}/`))).rejects.toThrow("boom");
  });

  it("answers instead when the app asked for a legible failure", async () => {
    const handler = await createWebAppHandler({
      basePath: BASE,
      requestUpstream: Promise.resolve({
        handler: () => {
          throw new Error("boom");
        },
      }),
      onError: (err) => ({
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: String(err) }),
      }),
    });
    const res = await handler(event(`${BASE}/`));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body!).error).toContain("boom");
  });
});

describe("pathCoveredBy", () => {
  it("matches the manifest's own subset relation", () => {
    expect(pathCoveredBy("/_next/static/*", "/_next/static/a.js")).toBe(true);
    expect(pathCoveredBy("/_next/static/*", "/_next/static")).toBe(true);
    expect(pathCoveredBy("/_next/static/*", "/_next/staticx")).toBe(false);
    expect(pathCoveredBy("/BUILD_ID", "/BUILD_ID")).toBe(true);
    expect(pathCoveredBy("/BUILD_ID", "/BUILD_ID/x")).toBe(false);
  });
});
