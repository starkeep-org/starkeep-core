/**
 * The order of the Hono app's routes, on the cloud surface.
 *
 * `POST /mcp` must stay ahead of the origin gate. An MCP client holds a
 * delegation token, never a session cookie, so behind the gate it would get
 * the gate's refusal instead of reaching the route's own delegation check.
 * The gate decides per request from `STARKEEP_APP_CLIENT_MODE`, so these
 * tests set it and send requests with no cookie.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/server/app.js";

const saved = process.env.STARKEEP_APP_CLIENT_MODE;

beforeEach(() => {
  process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
});

afterEach(() => {
  if (saved === undefined) delete process.env.STARKEEP_APP_CLIENT_MODE;
  else process.env.STARKEEP_APP_CLIENT_MODE = saved;
});

describe("on the cloud surface, with no session", () => {
  it("sends POST /mcp to the delegation check, not the gate", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // The delegation refusal names the Bearer scheme; the gate's does not.
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Bearer /);
    expect(await res.json()).toEqual({ error: "A valid delegation token is required" });
  });

  it("sends the job route to the job check, not the gate", async () => {
    const res = await app.request("/_starkeep/jobs/digest", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Dest": "empty" },
      body: JSON.stringify({ job: "digest", runId: "r1", trigger: "manual" }),
    });
    // The job refusal is a bare 404, so a probe learns nothing; the gate's is a 401.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("gates the signing proxy: a page load goes to sign-in", async () => {
    const res = await app.request("/api/local-data/data/types");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).pathname).toMatch(/\/sign-in$/);
  });

  it("gates the signing proxy: a script's write gets a 401", async () => {
    const res = await app.request("/api/local-data/data/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Dest": "empty" },
      body: JSON.stringify({ labels: [] }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("gates the app's own routes", async () => {
    for (const path of ["/api/notes-by-day", "/api/cloud-address", "/api/jobs", "/api/vault"]) {
      const res = await app.request(path, { headers: { "Sec-Fetch-Dest": "empty" } });
      expect(res.status, path).toBe(401);
    }
    for (const [method, path] of [
      ["POST", "/api/jobs/digest/run"],
      ["PUT", "/api/vault/provider-token"],
      ["DELETE", "/api/vault/provider-token"],
    ] as const) {
      const res = await app.request(path, { method, headers: { "Sec-Fetch-Dest": "empty" } });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("answers a job or vault route 401 when the cookie holds no live session", async () => {
    for (const [method, path] of [
      ["GET", "/api/jobs"],
      ["POST", "/api/jobs/digest/run"],
      ["GET", "/api/vault"],
      ["PUT", "/api/vault/provider-token"],
      ["DELETE", "/api/vault/provider-token"],
    ] as const) {
      const res = await app.request(path, { method, headers: { Cookie: "sk_session=x" } });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json()).toEqual({ error: "Sign in first" });
    }
  });

  it("serves the manifest's public paths", async () => {
    const config = await app.request("/starkeep-runtime-config");
    expect(config.status).toBe(200);
    const signIn = await app.request("/sign-in");
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("Content-Type")).toMatch(/^text\/html/);
  });

  it("answers the cloud address as null, since the page's own origin is the cloud's", async () => {
    const res = await app.request("/api/cloud-address", {
      headers: { Cookie: "sk_session=x" },
    });
    expect(await res.json()).toEqual({ url: null });
  });
});
