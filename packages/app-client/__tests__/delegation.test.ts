/**
 * Serving outside clients: `verifyDelegation` on both surfaces, and the
 * token's path to the data server through `signedFetch` and the proxy.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delegationRefusal, resetDelegationKeyCache, verifyDelegation } from "../src/delegation";
import { proxyToDataServer } from "../src/proxy";
import { signedFetch } from "../src/sign";

const BASE = "https://abc.execute-api.us-east-1.amazonaws.com";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KID = "kid-1";
const saved = { ...process.env };

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(over: Record<string, unknown> = {}, key: KeyObject = privateKey, kid = KID): string {
  const input = `${b64({ alg: "ES256", typ: "JWT", kid })}.${b64({
    sub: "user-1",
    aud: "probe",
    sk_dlg: "dlg-1",
    sk_mode: "read",
    sk_channel: "app",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...over,
  })}`;
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `skd_${input}.${sig.toString("base64url")}`;
}

function req(headers: Record<string, string>, method = "POST") {
  return { method, headers: new Headers(headers) };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetDelegationKeyCache();
  fetchMock = vi.fn(async (input: unknown) => {
    if (String(input) === `${BASE}/connect/jwks.json`) {
      return new Response(
        JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID }] }),
      );
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
});

describe("verifyDelegation in the cloud", () => {
  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    process.env.STARKEEP_APP_ID = "probe";
    process.env.STARKEEP_CLOUD_DATA_BASE = BASE;
  });

  it("returns the user, the mode and the token to forward", async () => {
    const t = token();
    expect(await verifyDelegation(req({ authorization: `Bearer ${t}` }))).toEqual({
      surface: "cloud",
      userId: "user-1",
      delegationId: "dlg-1",
      mode: "read",
      token: t,
    });
  });

  it("fetches the key set once and reuses it", async () => {
    await verifyDelegation(req({ authorization: `Bearer ${token()}` }));
    await verifyDelegation(req({ authorization: `Bearer ${token()}` }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a token for another app, an expired one and a forged one", async () => {
    const forger = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    for (const t of [
      token({ aud: "photos" }),
      token({ exp: Math.floor(Date.now() / 1000) - 1 }),
      token({}, forger),
      token({ sk_mode: "admin" }),
    ]) {
      expect(await verifyDelegation(req({ authorization: `Bearer ${t}` }))).toBeNull();
    }
  });

  it("refuses a request with no bearer, or a bearer that is not a delegation token", async () => {
    expect(await verifyDelegation(req({}))).toBeNull();
    expect(await verifyDelegation(req({ authorization: "Bearer eyJ.a.b" }))).toBeNull();
  });

  it("refuses a loopback caller in the cloud, where loopback means nothing", async () => {
    expect(await verifyDelegation(req({ host: "127.0.0.1:4000" }))).toBeNull();
  });
});

describe("verifyDelegation on the local surface", () => {
  beforeEach(() => {
    delete process.env.STARKEEP_APP_CLIENT_MODE;
  });

  it("admits a loopback caller with full app power and no token", async () => {
    expect(await verifyDelegation(req({ host: "127.0.0.1:4000" }))).toEqual({
      surface: "local",
      userId: null,
      delegationId: null,
      mode: "readwrite",
      token: null,
    });
  });

  it("refuses a non-loopback Host and a page on another site", async () => {
    expect(await verifyDelegation(req({ host: "evil.example" }))).toBeNull();
    expect(
      await verifyDelegation(req({ host: "localhost:4000", "sec-fetch-site": "cross-site" })),
    ).toBeNull();
  });
});

describe("forwarding the token", () => {
  const creds = { appId: "probe", hmacSecret: "s", dataServerUrl: `${BASE}/apps/probe` };

  it("signedFetch sends the token beside the signature", async () => {
    await signedFetch(creds, "/app-data/db/probe_notes", { delegation: "skd_x" });
    const headers = fetchMock.mock.calls.at(-1)![1].headers as Record<string, string>;
    expect(headers["X-Starkeep-Delegation"]).toBe("skd_x");
    expect(headers["X-Starkeep-App-Sig"]).toBeDefined();
  });

  it("signedFetch sends no delegation header for a local or app-own call", async () => {
    await signedFetch(creds, "/app-data/db/probe_notes", { delegation: null });
    const headers = fetchMock.mock.calls.at(-1)![1].headers as Record<string, string>;
    expect(headers["X-Starkeep-Delegation"]).toBeUndefined();
  });

  it("the proxy sends the delegation in place of a user token", async () => {
    await proxyToDataServer(creds, {
      method: "GET",
      path: "/app-data/db/probe_notes",
      headers: {},
      userToken: "id-token",
      delegationToken: "skd_x",
    });
    const headers = fetchMock.mock.calls.at(-1)![1].headers as Record<string, string>;
    expect(headers["X-Starkeep-Delegation"]).toBe("skd_x");
    expect(headers["X-Starkeep-User-Token"]).toBeUndefined();
  });
});

describe("delegationRefusal", () => {
  it("tells a client a bearer token is expected", () => {
    const res = delegationRefusal();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });
});
