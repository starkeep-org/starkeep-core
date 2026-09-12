/**
 * GET /api/apps/[appId]/install-status — the install-step ledger, proxied.
 *
 * Two things are worth pinning. The route reads the app id from a **promise**
 * of the route parameters, which is the argument a router change reshapes; and
 * it distinguishes "the data server is not running" from "the data server said
 * no", because the first is the ordinary state of a fresh machine and the
 * second is a half-failed install the operator has to look at.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getRequest, makeDataDir, startStubServer, type StubServer } from "./helpers";

type Ctx = { params: Promise<{ appId: string }> };
let GET: (req: Request, ctx: Ctx) => Promise<Response>;
let upstream: StubServer;
let reply: { status: number; body: string } = { status: 200, body: "{}" };

beforeAll(async () => {
  process.env.STARKEEP_DIR = makeDataDir("adminweb-install-status-");
  upstream = await startStubServer(() => reply);
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = upstream.url;
  ({ GET } = (await import("../app/api/apps/[appId]/install-status/route")) as unknown as {
    GET: typeof GET;
  });
});

afterAll(async () => {
  await upstream.stop();
});

const call = (appId: string) =>
  GET(getRequest(`/api/apps/${appId}/install-status`), {
    params: Promise.resolve({ appId }),
  });

describe("the route parameter", () => {
  it("reads the app id from the path and asks the ledger for that app", async () => {
    reply = { status: 200, body: JSON.stringify({ steps: [] }) };
    await call("photos");
    expect(upstream.seen.at(-1)!.url).toBe("/admin/apps/photos/install-steps");
  });

  it("encodes an app id that would otherwise reshape the upstream path", async () => {
    // The id reaches the upstream as one path segment. An id carrying a slash
    // would address a different route on the data server entirely.
    reply = { status: 200, body: "{}" };
    await call("a/b");
    expect(upstream.seen.at(-1)!.url).toBe("/admin/apps/a%2Fb/install-steps");
  });
});

describe("what it answers", () => {
  it("passes the ledger through on success", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ steps: [{ step: "register_app", status: "done" }] }),
    };
    const res = await call("photos");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steps: [{ step: "register_app", status: "done" }] });
  });

  it("passes an upstream refusal through with its own status", async () => {
    reply = { status: 404, body: "no such app" };
    const res = await call("ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; status: number; body: string };
    expect(body.error).toContain("install-steps lookup failed");
    expect(body.status).toBe(404);
    expect(body.body).toBe("no such app");
  });
});

describe("when the data server is not running", () => {
  it("answers 502 with the reason rather than throwing", async () => {
    // The route captures its upstream URL at module load, so pointing it at a
    // dead port means loading a second copy of the module.
    vi.resetModules();
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL = "http://127.0.0.1:1";
    const { GET: downGET } = (await import(
      "../app/api/apps/[appId]/install-status/route"
    )) as unknown as { GET: typeof GET };
    process.env.STARKEEP_LOCAL_DATA_SERVER_URL = upstream.url;

    const res = await downGET(getRequest("/api/apps/photos/install-status"), {
      params: Promise.resolve({ appId: "photos" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toContain("Could not reach local-data-server");
    expect(body.detail).toBeTruthy();
  });
});
