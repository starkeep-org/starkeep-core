/**
 * /api/this-machine — this machine's sign-in, forwarded to the local data
 * server's loopback-only `/auth/*` routes, and joining a cloud by address.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, makeDataDir, startStubServer, type StubServer } from "./helpers";

let daemon: StubServer;
let reply: { status: number; body: string } = { status: 200, body: "{}" };
let route: typeof import("../src/routes/this-machine");

beforeAll(async () => {
  process.env.STARKEEP_DIR = makeDataDir("adminweb-this-machine-");
  daemon = await startStubServer(() => reply);
  vi.doMock("../src/lib/runtime-config", () => ({
    localDataServerUrl: async () => daemon.url,
    getRuntimeConfig: async () => ({ localDataServerUrl: daemon.url, driveUrl: daemon.url }),
  }));
  route = await import("../src/routes/this-machine");
});

afterAll(async () => {
  await daemon.stop();
});

beforeEach(() => {
  reply = { status: 200, body: "{}" };
  daemon.seen.length = 0;
});

describe("this machine's sign-in", () => {
  it("reads the sign-in from the daemon", async () => {
    reply = { status: 200, body: JSON.stringify({ state: "signed-in", email: "a@example.com" }) };
    expect(await (await route.GET()).json()).toMatchObject({
      state: "signed-in",
      email: "a@example.com",
    });
    expect(daemon.seen.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /auth/status"]);
  });

  it("passes a sign-in through to the daemon, with no Origin of its own", async () => {
    reply = { status: 200, body: JSON.stringify({ challenge: "NEW_PASSWORD_REQUIRED" }) };
    const res = await route.POST_SIGN_IN(
      jsonRequest("/api/this-machine/sign-in", { email: "a@example.com", password: "Temp-1" }),
    );
    expect(await res.json()).toEqual({ challenge: "NEW_PASSWORD_REQUIRED" });
    const sent = daemon.seen.at(-1)!;
    expect(sent).toMatchObject({ method: "POST", url: "/auth/login" });
    expect(JSON.parse(sent.body)).toEqual({ email: "a@example.com", password: "Temp-1" });
    // The daemon refuses any request that carries an Origin.
    expect(sent.headers?.["origin"]).toBeUndefined();
  });

  it("passes the daemon's refusal through with its status", async () => {
    reply = { status: 401, body: JSON.stringify({ error: "Incorrect username or password." }) };
    const res = await route.POST_SIGN_IN(
      jsonRequest("/api/this-machine/sign-in", { email: "a@example.com", password: "wrong" }),
    );
    expect(res.status).toBe(401);
  });

  it("signs out through the daemon", async () => {
    reply = { status: 200, body: JSON.stringify({ ok: true, revocation: "revoked" }) };
    await route.POST_SIGN_OUT(jsonRequest("/api/this-machine/sign-out", {}));
    expect(daemon.seen.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /auth/sign-out"]);
  });

  it.each([
    ["another site's page", "https://evil.example"],
    ["a request with no page at all", ""],
  ])("refuses a sign-in from %s, and reaches nothing", async (_name, origin) => {
    const req = jsonRequest(
      "/api/this-machine/sign-in",
      { email: "a@example.com", password: "x" },
      "POST",
      origin,
    );
    if (!origin) req.headers.delete("origin");
    const res = await route.POST_SIGN_IN(req);
    expect(res.status).toBe(403);
    expect(daemon.seen).toEqual([]);
  });

  it("refuses a sign-out from another site's page", async () => {
    const res = await route.POST_SIGN_OUT(
      jsonRequest("/api/this-machine/sign-out", {}, "POST", "https://evil.example"),
    );
    expect(res.status).toBe(403);
    expect(daemon.seen).toEqual([]);
  });

  it("says the daemon is offline rather than failing", async () => {
    await daemon.stop();
    try {
      const res = await route.GET();
      expect(res.status).toBe(503);
      expect(((await res.json()) as { offline: boolean }).offline).toBe(true);
    } finally {
      daemon = await startStubServer(() => reply);
      vi.doMock("../src/lib/runtime-config", () => ({
        localDataServerUrl: async () => daemon.url,
        getRuntimeConfig: async () => ({ localDataServerUrl: daemon.url, driveUrl: daemon.url }),
      }));
    }
  });
});

describe("joining a cloud", () => {
  it("records the address as the daemon's cloud, without a trailing slash", async () => {
    const res = await route.POST_CLOUD(
      jsonRequest("/api/this-machine/cloud", { url: " https://d1.cloudfront.net/ " }),
    );
    expect(res.status).toBe(200);
    const sent = daemon.seen.at(-1)!;
    expect(sent).toMatchObject({ method: "PATCH", url: "/config" });
    expect(JSON.parse(sent.body)).toEqual({ apiGatewayUrl: "https://d1.cloudfront.net" });
  });

  it("refuses a cloud address another site's page sends", async () => {
    const res = await route.POST_CLOUD(
      jsonRequest(
        "/api/this-machine/cloud",
        { url: "https://evil.example" },
        "POST",
        "https://evil.example",
      ),
    );
    expect(res.status).toBe(403);
    expect(daemon.seen).toEqual([]);
  });

  it.each([
    ["plain http", "http://d1.cloudfront.net"],
    ["not a URL", "d1"],
    ["nothing", ""],
  ])("refuses %s, and changes nothing", async (_name, url) => {
    const res = await route.POST_CLOUD(jsonRequest("/api/this-machine/cloud", { url }));
    expect(res.status).toBe(400);
    expect(daemon.seen).toEqual([]);
  });
});
