/**
 * /api/residency and /api/residency/policy — the daemon's residency projection,
 * proxied so the loopback assumption stays true.
 *
 * The daemon's `/residency/*` routes answer any caller on 127.0.0.1 and nobody
 * else, which is the gate that lets them be served without an app identity. A
 * browser fetch would come from the page's origin, so the proxy is what keeps
 * that gate load-bearing rather than accidental.
 *
 * Two behaviors carry the page. A daemon that is not running is the ordinary
 * state of a fresh machine, so it answers 503 with `offline: true` and the page
 * renders an offline state from it. And a PUT that saves a policy restarts the
 * daemon, so the response arrives just before the connection drops — a dropped
 * connection after a 200 is the normal case here, not a failure.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jsonRequest, makeDataDir, startStubServer, type StubServer } from "./helpers";

let daemon: StubServer;
let reply: { status: number; body: string } = { status: 200, body: "{}" };

let residencyGET: () => Promise<Response>;
let policyPOST: (req: Request) => Promise<Response>;
let policyPUT: (req: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.STARKEEP_DIR = makeDataDir("adminweb-residency-");
  daemon = await startStubServer(() => reply);

  // The browser learns the daemon's URL from /api/runtime-config; these routes
  // run server-side and read the same accessor, so the accessor is what the
  // test points at the stub. Nothing else in the module is stubbed.
  vi.doMock("../src/lib/runtime-config", () => ({
    localDataServerUrl: async () => daemon.url,
    getRuntimeConfig: async () => ({ localDataServerUrl: daemon.url, driveUrl: daemon.url }),
  }));

  ({ GET: residencyGET } = await import("../src/routes/residency"));
  const policy = await import("../src/routes/residency-policy");
  policyPOST = policy.POST as unknown as typeof policyPOST;
  policyPUT = policy.PUT as unknown as typeof policyPUT;
});

afterAll(async () => {
  await daemon.stop();
});

describe("GET /api/residency", () => {
  it("asks the daemon for its projection and passes it through", async () => {
    reply = { status: 200, body: JSON.stringify({ classes: [{ id: "originals" }] }) };
    const res = await residencyGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ classes: [{ id: "originals" }] });
    expect(daemon.seen.at(-1)!.url).toBe("/residency/projection");
  });

  it("passes a daemon refusal through with its own status", async () => {
    reply = { status: 500, body: "boom" };
    const res = await residencyGET();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("500");
  });
});

describe("POST /api/residency/policy — the dry run", () => {
  it("forwards the body verbatim and returns the daemon's status", async () => {
    reply = { status: 200, body: JSON.stringify({ projected: { originals: 12 } }) };
    const res = await policyPOST(
      jsonRequest("/api/residency/policy", { classes: { originals: "keep" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projected: { originals: 12 } });
    const sent = daemon.seen.at(-1)!;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/residency/projection");
    expect(JSON.parse(sent.body)).toEqual({ classes: { originals: "keep" } });
  });

  it("carries a rejection's status, so a bad policy is not reported as saved", async () => {
    reply = { status: 400, body: JSON.stringify({ error: "unknown class" }) };
    const res = await policyPOST(jsonRequest("/api/residency/policy", { classes: {} }));
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/residency/policy — the save", () => {
  it("forwards the body to the daemon's policy route", async () => {
    reply = { status: 200, body: JSON.stringify({ saved: true }) };
    const res = await policyPUT(
      jsonRequest("/api/residency/policy", { classes: { originals: "evict" } }, "PUT"),
    );
    expect(res.status).toBe(200);
    const sent = daemon.seen.at(-1)!;
    expect(sent.method).toBe("PUT");
    expect(sent.url).toBe("/residency/policy");
    expect(JSON.parse(sent.body)).toEqual({ classes: { originals: "evict" } });
  });
});

describe("when the daemon is not running", () => {
  it("answers 503 with offline: true on every one of the three routes", async () => {
    // Not a stack trace and not a 500: the page renders an offline state from
    // this, and a fresh machine reaches it before anything is wrong.
    vi.resetModules();
    vi.doMock("../src/lib/runtime-config", () => ({
      localDataServerUrl: async () => "http://127.0.0.1:1",
      getRuntimeConfig: async () => ({
        localDataServerUrl: "http://127.0.0.1:1",
        driveUrl: "http://127.0.0.1:1",
      }),
    }));
    const down = await import("../src/routes/residency");
    const downPolicy = await import("../src/routes/residency-policy");

    const calls: Array<Promise<Response>> = [
      down.GET(),
      (downPolicy.POST as unknown as typeof policyPOST)(
        jsonRequest("/api/residency/policy", {}),
      ),
      (downPolicy.PUT as unknown as typeof policyPUT)(
        jsonRequest("/api/residency/policy", {}, "PUT"),
      ),
    ];
    for (const call of calls) {
      const res = await call;
      expect(res.status).toBe(503);
      expect((await res.json()) as { offline: boolean }).toMatchObject({ offline: true });
    }
  });
});
