/**
 * The vault helpers: the user's calls carry the user's token, a job run's
 * calls carry the run's token, and the local surface reports cloudRequired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSecret, listSecrets, putSecret, readSecret } from "../src/vault";

const BASE = "https://abc.execute-api.us-east-1.amazonaws.com";
const CREDS = { appId: "probe", hmacSecret: "s", dataServerUrl: `${BASE}/apps/probe` };

let fetchMock: ReturnType<typeof vi.fn>;
let answer: () => Response;

beforeEach(() => {
  answer = () => new Response(null, { status: 204 });
  fetchMock = vi.fn(async () => answer());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
};

describe("the user's calls", () => {
  it("store a secret with the user's token and no delegation", async () => {
    expect(await putSecret("probe", "peloton", "rt-1", { userToken: "id", creds: CREDS })).toEqual({
      ok: true,
      value: null,
    });
    const { url, init, headers } = lastCall();
    expect(url).toBe(`${BASE}/apps/probe/vault/peloton`);
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ value: "rt-1" }));
    expect(headers["X-Starkeep-User-Token"]).toBe("id");
    expect(headers["X-Starkeep-Delegation"]).toBeUndefined();
  });

  it("list names and delete one", async () => {
    answer = () => Response.json({ secrets: [{ name: "peloton", updatedAt: 1 }] });
    expect(await listSecrets("probe", { userToken: "id", creds: CREDS })).toEqual({
      ok: true,
      value: [{ name: "peloton", updatedAt: 1 }],
    });
    answer = () => new Response(null, { status: 204 });
    expect((await deleteSecret("probe", "peloton", { userToken: "id", creds: CREDS })).ok).toBe(
      true,
    );
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("report a refusal with its status and message", async () => {
    answer = () =>
      Response.json({ error: "Only the app's scheduled jobs read a secret" }, { status: 403 });
    expect(await putSecret("probe", "peloton", "x", { userToken: "id", creds: CREDS })).toEqual({
      ok: false,
      cloudRequired: false,
      status: 403,
      error: "Only the app's scheduled jobs read a secret",
    });
  });
});

describe("a job run's calls", () => {
  it("read and rotate a secret with the run's token and no user token", async () => {
    answer = () => Response.json({ value: "rt-1" });
    expect(await readSecret("probe", "peloton", { delegation: "skd_run", creds: CREDS })).toEqual({
      ok: true,
      value: "rt-1",
    });
    expect(lastCall().headers["X-Starkeep-Delegation"]).toBe("skd_run");
    expect(lastCall().headers["X-Starkeep-User-Token"]).toBeUndefined();

    answer = () => new Response(null, { status: 204 });
    await putSecret("probe", "peloton", "rt-2", { delegation: "skd_run", creds: CREDS });
    expect(lastCall().headers["X-Starkeep-Delegation"]).toBe("skd_run");
  });

  it("read a missing secret as null", async () => {
    answer = () => Response.json({ error: "No secret called peloton" }, { status: 404 });
    expect(await readSecret("probe", "peloton", { delegation: "skd_run", creds: CREDS })).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("the local surface", () => {
  it("reports cloudRequired", async () => {
    answer = () => Response.json({ error: "x", code: "cloud-required" }, { status: 501 });
    const local = { ...CREDS, dataServerUrl: "http://127.0.0.1:9820" };
    expect(await listSecrets("probe", { userToken: null, creds: local })).toEqual({
      ok: false,
      cloudRequired: true,
    });
  });
});
