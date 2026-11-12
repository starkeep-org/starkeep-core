/**
 * The local surface's request checks, and the server that applies them.
 *
 * Nothing on the local surface asks who the caller is, so these checks are
 * what stand between a web page in the person's own browser and every route
 * that signs with the app's credential. The property under test is that a
 * refused request never reaches the app at all.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { localSurfaceGuard } from "../src/hono";
import { localRequestRefusal } from "../src/local-guard";
import { localFetch, localPort } from "../src/local";

function request(method: string, headers: Record<string, string>, path = "/api/x"): Request {
  return new Request(`http://127.0.0.1:4100${path}`, { method, headers });
}

describe("localRequestRefusal", () => {
  it.each(["127.0.0.1:4100", "localhost:4100", "[::1]:4100", "LOCALHOST"])(
    "lets a loopback Host %s through",
    (host) => {
      expect(localRequestRefusal(request("GET", { host }))).toBeNull();
    },
  );

  it("refuses a Host that is not loopback, which is what a DNS-rebinding page sends", () => {
    expect(localRequestRefusal(request("GET", { host: "evil.example:4100" }))).toMatch(/loopback/);
  });

  it("lets a request with no Host through, since no browser sent it", () => {
    expect(localRequestRefusal({ method: "POST", headers: new Headers() })).toBeNull();
  });

  it.each(["cross-site", "same-site"])("refuses a %s write", (site) => {
    const refused = localRequestRefusal(
      request("POST", {
        host: "127.0.0.1:4100",
        "sec-fetch-site": site,
        "sec-fetch-mode": "no-cors",
      }),
    );
    expect(refused).toMatch(/other sites/);
  });

  it("lets a same-origin write through", () => {
    const req = request("POST", { host: "127.0.0.1:4100", "sec-fetch-site": "same-origin" });
    expect(localRequestRefusal(req)).toBeNull();
  });

  it("lets a link from another site open the app, so admin-web's Open works", () => {
    const req = request(
      "GET",
      { host: "127.0.0.1:4100", "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" },
      "/",
    );
    expect(localRequestRefusal(req)).toBeNull();
  });

  it("refuses a form POST from another site, although it is a navigation", () => {
    const req = request("POST", {
      host: "127.0.0.1:4100",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
    });
    expect(localRequestRefusal(req)).toMatch(/other sites/);
  });

  describe("a browser that sends no Sec-Fetch-Site", () => {
    it("refuses a write whose Origin is another port on this machine", () => {
      const req = request("POST", { host: "127.0.0.1:4100", origin: "http://127.0.0.1:5173" });
      expect(localRequestRefusal(req)).toMatch(/other sites/);
    });

    it("refuses a write from an opaque origin", () => {
      const req = request("POST", { host: "127.0.0.1:4100", origin: "null" });
      expect(localRequestRefusal(req)).toMatch(/other sites/);
    });

    it("lets a write from this server's own origin through", () => {
      const req = request("POST", { host: "127.0.0.1:4100", origin: "http://127.0.0.1:4100" });
      expect(localRequestRefusal(req)).toBeNull();
    });

    it("lets a read through, because a cross-origin page cannot see the answer", () => {
      const req = request("GET", { host: "127.0.0.1:4100", origin: "http://evil.example" });
      expect(localRequestRefusal(req)).toBeNull();
    });
  });
});

describe("localFetch", () => {
  function assets(): string {
    const dir = mkdtempSync(join(tmpdir(), "local-guard-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><p>shell</p>");
    return dir;
  }

  it("answers a refused request with 403 and never calls the app", async () => {
    const app = { fetch: vi.fn(async () => new Response("signed")) };
    const res = await localFetch({ app })(
      request("POST", { host: "127.0.0.1:4100", "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
    expect(app.fetch).not.toHaveBeenCalled();
  });

  it("refuses a static path too, so the guard covers every route", async () => {
    const app = { fetch: vi.fn(async () => new Response("app")) };
    const handle = localFetch({
      app,
      static: { assetsDir: assets(), staticPaths: ["/"], immutablePaths: [], shellPaths: ["/"] },
    });
    const res = await handle(request("GET", { host: "evil.example" }, "/"));
    expect(res.status).toBe(403);
  });

  it("serves static paths ahead of the app, as the cloud adapter does", async () => {
    const app = { fetch: vi.fn(async () => new Response("app")) };
    const handle = localFetch({
      app,
      static: { assetsDir: assets(), staticPaths: ["/"], immutablePaths: [], shellPaths: ["/"] },
    });
    const shell = await handle(request("GET", { host: "127.0.0.1:4100" }, "/"));
    expect(await shell.text()).toContain("shell");
    expect(app.fetch).not.toHaveBeenCalled();

    const route = await handle(request("GET", { host: "127.0.0.1:4100" }, "/api/x"));
    expect(await route.text()).toBe("app");
  });
});

describe("localSurfaceGuard", () => {
  it("stops a refused request before the app's routes", async () => {
    const reached = vi.fn();
    const app = new Hono();
    app.use("*", localSurfaceGuard());
    app.post("/api/x", (c) => {
      reached();
      return c.text("signed");
    });
    const res = await app.fetch(
      request("POST", { host: "127.0.0.1:4100", "sec-fetch-site": "same-site" }),
    );
    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();

    const ok = await app.fetch(request("POST", { host: "127.0.0.1:4100" }));
    expect(await ok.text()).toBe("signed");
  });
});

describe("localPort", () => {
  it("reads --port first", () => {
    expect(localPort(["node", "local.js", "--port", "4100"], { PORT: "9" })).toBe(4100);
  });

  it("falls back to PORT", () => {
    expect(localPort(["node", "local.js"], { PORT: "4200" })).toBe(4200);
  });

  it("refuses to guess a port", () => {
    expect(() => localPort(["node", "local.js"], {})).toThrow(/--port/);
    expect(() => localPort(["node", "local.js", "--port", "x"], {})).toThrow(/--port/);
  });
});
