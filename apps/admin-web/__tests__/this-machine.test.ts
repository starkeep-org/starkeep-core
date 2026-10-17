/**
 * /api/this-machine — this machine's device key, forwarded to the local data
 * server's loopback-only `/device` routes, and joining a cloud by address.
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

describe("this machine's key", () => {
  it("reads, makes and checks the key through the daemon", async () => {
    reply = { status: 200, body: JSON.stringify({ deviceId: "dev_a", approval: { state: "pending" } }) };
    expect(await (await route.GET()).json()).toMatchObject({ deviceId: "dev_a" });
    await route.POST_KEY(jsonRequest("/api/this-machine/key", { label: "Laptop" }));
    await route.POST_CHECK();
    expect(daemon.seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /device",
      "POST /device/key",
      "POST /device/check",
    ]);
    expect(JSON.parse(daemon.seen[1]!.body)).toEqual({ label: "Laptop" });
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
    const res = await route.POST_CLOUD(jsonRequest("/api/this-machine/cloud", { url: " https://d1.cloudfront.net/ " }));
    expect(res.status).toBe(200);
    const sent = daemon.seen.at(-1)!;
    expect(sent).toMatchObject({ method: "PATCH", url: "/config" });
    expect(JSON.parse(sent.body)).toEqual({ apiGatewayUrl: "https://d1.cloudfront.net" });
  });

  it.each([["plain http", "http://d1.cloudfront.net"], ["not a URL", "d1"], ["nothing", ""]])(
    "refuses %s, and changes nothing",
    async (_name, url) => {
      const res = await route.POST_CLOUD(jsonRequest("/api/this-machine/cloud", { url }));
      expect(res.status).toBe(400);
      expect(daemon.seen).toEqual([]);
    },
  );
});
