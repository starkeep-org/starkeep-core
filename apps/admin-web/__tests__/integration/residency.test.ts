/**
 * /api/residency/stand-ins and /api/residency/free-up-space — the daemon's
 * residency routes, proxied so the loopback assumption stays true.
 *
 * The daemon's `/residency/*` routes answer any caller on 127.0.0.1 and nobody
 * else, which is the gate that lets them be served without an app identity. A
 * browser fetch would come from the page's origin, so the proxy is what keeps
 * that gate load-bearing rather than accidental.
 *
 * A daemon that is not running is the ordinary state of a fresh machine, so
 * every route answers 503 with `offline: true` and the page renders an offline
 * state from it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsonRequest, makeDataDir, startStubServer, type StubServer } from "../helpers";

let daemon: StubServer;
let reply: { status: number; body: string } = { status: 200, body: "{}" };

let standIns: typeof import("../../src/routes/stand-ins");

beforeAll(async () => {
  process.env.STARKEEP_DIR = makeDataDir("adminweb-residency-");
  daemon = await startStubServer(() => reply);

  // The routes read the daemon's address from the environment per request, the
  // same way `/api/runtime-config` serves it to the browser.
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = daemon.url;

  standIns = await import("../../src/routes/stand-ins");
});

afterAll(async () => {
  await daemon.stop();
});

describe("/api/residency/stand-ins and /api/residency/free-up-space", () => {
  it("reads this node's ceilings from the daemon", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ nodeKind: "desktop", ceilings: { image: 2560 } }),
    };
    const res = await standIns.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodeKind: "desktop", ceilings: { image: 2560 } });
    expect(daemon.seen.at(-1)!).toMatchObject({ method: "GET", url: "/residency/stand-ins" });
  });

  it("reads the deployment's standards through the daemon", async () => {
    reply = { status: 200, body: JSON.stringify({ set: false }) };
    const read = await standIns.GET_LIBRARY_STANDARDS();
    expect(await read.json()).toEqual({ set: false });
    expect(daemon.seen.at(-1)!).toMatchObject({
      method: "GET",
      url: "/library/stand-in-standards",
    });
  });

  it("saves ceilings verbatim and carries a refusal's status", async () => {
    reply = {
      status: 422,
      body: JSON.stringify({ problems: ["image: a ceiling is a positive whole fidelity"] }),
    };
    const res = await standIns.PUT(
      jsonRequest("/api/residency/stand-ins", { ceilings: { image: -1 } }, "PUT"),
    );
    expect(res.status).toBe(422);
    const sent = daemon.seen.at(-1)!;
    expect(sent).toMatchObject({ method: "PUT", url: "/residency/stand-ins" });
    expect(JSON.parse(sent.body)).toEqual({ ceilings: { image: -1 } });
  });

  it("forwards a Free up space request to the daemon", async () => {
    reply = { status: 200, body: JSON.stringify({ dryRun: true, freedBytes: 10 }) };
    const res = await standIns.POST_FREE_UP_SPACE(
      jsonRequest("/api/residency/free-up-space", { bytes: 10, scope: "originals", dryRun: true }),
    );
    expect(res.status).toBe(200);
    const sent = daemon.seen.at(-1)!;
    expect(sent).toMatchObject({ method: "POST", url: "/residency/free-up-space" });
    expect(JSON.parse(sent.body)).toEqual({ bytes: 10, scope: "originals", dryRun: true });
  });
});

describe("when the daemon is not running", () => {
  it("answers 503 with offline: true on every one of the routes", async () => {
    // Not a stack trace and not a 500: the page renders an offline state from
    // this, and a fresh machine reaches it before anything is wrong.
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL = "http://127.0.0.1:1";
    try {
      const calls: Array<Promise<Response>> = [
        standIns.GET(),
        standIns.PUT(jsonRequest("/api/residency/stand-ins", {}, "PUT")),
        standIns.POST_FREE_UP_SPACE(jsonRequest("/api/residency/free-up-space", {})),
      ];
      for (const call of calls) {
        const res = await call;
        expect(res.status).toBe(503);
        expect((await res.json()) as { offline: boolean }).toMatchObject({ offline: true });
      }
    } finally {
      process.env.STARKEEP_LOCAL_DATA_SERVER_URL = daemon.url;
    }
  });
});
