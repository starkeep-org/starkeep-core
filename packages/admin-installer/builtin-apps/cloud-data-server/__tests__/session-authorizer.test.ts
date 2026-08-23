/**
 * The platform session authorizer.
 *
 * Two properties, and the second matters as much as the first. It must refuse
 * every bad token — and it must never throw while doing it. An authorizer that
 * throws is a 500, and on the auth path a 500 is indistinguishable from an
 * outage: the operator sees the site down, not a rejected caller.
 */
import type { webcrypto } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handler, readCookie, resetKeySetCache } from "../src/session-authorizer.js";

// This package compiles against the ES2022 lib, so the WebCrypto types the
// `crypto` global hands back live under node:crypto rather than in the DOM lib.
type CryptoKey = webcrypto.CryptoKey;
type JsonWebKey = webcrypto.JsonWebKey;

const REGION = "us-east-2";
const POOL = "us-east-2_TESTPOOL";
const CLIENT = "client-abc";

interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

let key: TestKey;
let otherKey: TestKey;
const saved = { ...process.env };

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function makeKey(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...pub, kid, alg: "RS256", use: "sig" } };
}

async function signJwt(
  k: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: k.kid, ...header })).toString(
    "base64url",
  );
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    k.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`,
    aud: CLIENT,
    token_use: "id",
    sub: "user-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}

function event(cookie?: string, headerName = "cookie") {
  return { headers: cookie === undefined ? {} : { [headerName]: cookie } };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  key ??= await makeKey("kid-1");
  otherKey ??= await makeKey("kid-2");
  resetKeySetCache();
  process.env.AWS_REGION = REGION;
  process.env.STARKEEP_USER_POOL_ID = POOL;
  process.env.STARKEEP_USER_POOL_CLIENT_ID = CLIENT;
  fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe("allows", () => {
  it("a valid session cookie", async () => {
    const token = await signJwt(key, claims());
    const res = await handler(event(`sk_token=${token}`));
    expect(res.isAuthorized).toBe(true);
    expect(res.context?.sub).toBe("user-1");
  });

  it("a cookie header carrying other cookies alongside it", async () => {
    const token = await signJwt(key, claims());
    const res = await handler(event(`a=1; sk_token=${token}; sk_session=refresh`));
    expect(res.isAuthorized).toBe(true);
  });

  it("a `Cookie` header with the capital C a caller may send", async () => {
    const token = await signJwt(key, claims());
    expect((await handler(event(`sk_token=${token}`, "Cookie"))).isAuthorized).toBe(true);
  });
});

describe("refuses", () => {
  it("a missing Cookie header", async () => {
    expect(await handler(event())).toEqual({ isAuthorized: false });
    expect(await handler({})).toEqual({ isAuthorized: false });
  });

  it("a cookie header with no sk_token", async () => {
    expect((await handler(event("sk_session=refresh; other=1"))).isAuthorized).toBe(false);
  });

  it("an expired token", async () => {
    const token = await signJwt(key, claims({ exp: Math.floor(Date.now() / 1000) - 1 }));
    expect((await handler(event(`sk_token=${token}`))).isAuthorized).toBe(false);
  });

  it("a wrong-audience token", async () => {
    const token = await signJwt(key, claims({ aud: "someone-elses-client" }));
    expect((await handler(event(`sk_token=${token}`))).isAuthorized).toBe(false);
  });

  it("a wrong-issuer token", async () => {
    const token = await signJwt(key, claims({ iss: "https://evil.example.com/pool" }));
    expect((await handler(event(`sk_token=${token}`))).isAuthorized).toBe(false);
  });

  it("an access token where an id token is required", async () => {
    const token = await signJwt(key, claims({ token_use: "access" }));
    expect((await handler(event(`sk_token=${token}`))).isAuthorized).toBe(false);
  });

  it("a token signed by a key the pool does not publish", async () => {
    const token = await signJwt({ ...otherKey, kid: key.kid }, claims());
    expect((await handler(event(`sk_token=${token}`))).isAuthorized).toBe(false);
  });

  it("a token whose kid nobody publishes, after exactly one re-fetch", async () => {
    const token = await signJwt({ ...key, kid: "kid-nobody-has" }, claims());
    expect((await handler(event(`sk_token=${token}`))).isAuthorized).toBe(false);
    // An unauthenticated caller must not be able to drive unbounded JWKS
    // traffic by inventing kids.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an unsigned (alg: none) token", async () => {
    const token = await signJwt(key, claims(), { alg: "none" });
    expect((await handler(event(`sk_token=${token}`))).isAuthorized).toBe(false);
  });
});

describe("never throws", () => {
  it("on malformed garbage in the cookie", async () => {
    for (const value of ["", "not-a-jwt", "a.b", "a.b.c.d", "...", "%%%"]) {
      await expect(handler(event(`sk_token=${value}`))).resolves.toEqual({ isAuthorized: false });
    }
  });

  it("when the JWKS endpoint is down", async () => {
    fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));
    const token = await signJwt(key, claims());
    await expect(handler(event(`sk_token=${token}`))).resolves.toEqual({ isAuthorized: false });
  });

  it("when the network fails outright", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });
    const token = await signJwt(key, claims());
    await expect(handler(event(`sk_token=${token}`))).resolves.toEqual({ isAuthorized: false });
  });

  it("when the deployment has no user pool configured", async () => {
    delete process.env.STARKEEP_USER_POOL_ID;
    await expect(handler(event("sk_token=x"))).resolves.toEqual({ isAuthorized: false });
  });
});

describe("caching", () => {
  it("fetches the JWKS once across many authorizations", async () => {
    const token = await signJwt(key, claims());
    await Promise.all([
      handler(event(`sk_token=${token}`)),
      handler(event(`sk_token=${token}`)),
      handler(event(`sk_token=${token}`)),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed fetch", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("blip");
    });
    const token = await signJwt(key, claims());
    expect((await handler(event(`sk_token=${token}`))).isAuthorized).toBe(false);
    expect((await handler(event(`sk_token=${token}`))).isAuthorized).toBe(true);
  });
});

describe("readCookie", () => {
  it("does not truncate a JWT on its internal padding or dots", () => {
    const jwt = "aGVhZGVy.cGF5bG9hZA==.c2ln";
    expect(readCookie(`sk_token=${jwt}`, "sk_token")).toBe(jwt);
  });

  it("matches the whole name, not a prefix of one", () => {
    expect(readCookie("sk_token_other=x; sk_token=y", "sk_token")).toBe("y");
  });

  it("returns null for an absent header or name", () => {
    expect(readCookie(undefined, "sk_token")).toBeNull();
    expect(readCookie("a=1", "sk_token")).toBeNull();
  });
});
