/**
 * Cookie mechanics and the mint/re-mint path.
 *
 * The cookie flags are the security property here: a refresh token that ends
 * up readable from JavaScript is the thing this whole layer exists to prevent,
 * so the flags are asserted individually rather than by string equality on the
 * whole header.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SESSION_COOKIE,
  TOKEN_COOKIE,
  clearCookies,
  cookiePath,
  mintIdToken,
  parseCookieHeader,
  readCookie,
  requireSession,
  sessionCookie,
  setCookie,
  tokenCookie,
} from "../src/auth/session.js";
import { clearJwksCache } from "../src/auth/verify.js";
import type { MinimalNextRequest } from "../src/next.js";
import { makeKey, signJwt, type TestKey } from "./auth-jwt.js";

const REGION = "us-east-2";
const POOL = "us-east-2_TESTPOOL";
const CLIENT = "client-abc";

let key: TestKey;
let fetchMock: ReturnType<typeof vi.fn>;
const saved = { ...process.env };

function idClaims(over: Record<string, unknown> = {}) {
  return {
    iss: `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`,
    aud: CLIENT,
    token_use: "id",
    sub: "user-1",
    email: "a@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}

function request(cookie?: string): MinimalNextRequest {
  return {
    method: "GET",
    url: "https://cdn.example.com/apps/memo/api/local-data/app-data/db/decks",
    headers: { get: (n: string) => (n.toLowerCase() === "cookie" ? (cookie ?? null) : null) },
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

/** JWKS for every request; Cognito calls are opted into per test. */
function baseFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(async () => {
  key ??= await makeKey("kid-1");
  clearJwksCache();
  process.env.AWS_REGION = REGION;
  process.env.STARKEEP_USER_POOL_ID = POOL;
  process.env.STARKEEP_USER_POOL_CLIENT_ID = CLIENT;
  fetchMock = baseFetch();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
});

describe("cookie serialization", () => {
  it("scopes the session cookie to the app and marks it unreadable from script", () => {
    const header = sessionCookie("memo", "refresh-token-value", 3600);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/apps/memo");
    expect(header).toContain("Max-Age=3600");
    expect(header.startsWith(`${SESSION_COOKIE}=refresh-token-value`)).toBe(true);
  });

  it("gives the token cookie the same protections", () => {
    const header = tokenCookie("photos", "id-token-value", 3600);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/apps/photos");
  });

  it("scopes by app id so two apps on one distribution cannot see each other", () => {
    expect(cookiePath("memo")).toBe("/apps/memo");
    expect(cookiePath("photos")).toBe("/apps/photos");
  });

  it("percent-encodes a value that would otherwise break the header", () => {
    expect(setCookie("x", "a;b c", { path: "/" })).toContain("x=a%3Bb%20c");
  });

  it("sign-out emits a clearing cookie for both", () => {
    const cookies = clearCookies("memo");
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${TOKEN_COOKIE}=`))).toBe(true);
    for (const c of cookies) {
      expect(c).toContain("Max-Age=0");
      expect(c).toContain("Path=/apps/memo");
    }
  });
});

describe("cookie parsing", () => {
  it("reads a named cookie out of a multi-cookie header", () => {
    const req = request(`other=1; ${TOKEN_COOKIE}=abc; ${SESSION_COOKIE}=def`);
    expect(readCookie(req, TOKEN_COOKIE)).toBe("abc");
    expect(readCookie(req, SESSION_COOKIE)).toBe("def");
    expect(readCookie(req, "absent")).toBeNull();
  });

  it("survives a header with no cookies at all", () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
    expect(parseCookieHeader("junk")).toEqual({});
  });

  it("round-trips a percent-encoded value", () => {
    expect(parseCookieHeader(setCookie("x", "a;b", { path: "/" }).split(";")[0]).x).toBe("a;b");
  });
});

describe("mintIdToken", () => {
  it("uses a live sk_token without going to Cognito", async () => {
    const token = await signJwt(key, idClaims());
    const minted = await mintIdToken(request(`${TOKEN_COOKIE}=${token}`), "memo");
    expect(minted?.claims.sub).toBe("user-1");
    expect(minted?.setCookie).toBeUndefined();
    expect(fetchMock.mock.calls.every(([u]) => String(u).includes("jwks.json"))).toBe(true);
  });

  it("re-mints from sk_session when the token is within a minute of expiry", async () => {
    const nearlyDead = await signJwt(key, idClaims({ exp: Math.floor(Date.now() / 1000) + 30 }));
    const fresh = await signJwt(key, idClaims());
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          AuthenticationResult: { IdToken: fresh, AccessToken: "a", ExpiresIn: 3600 },
        }),
        { status: 200 },
      );
    });

    const minted = await mintIdToken(
      request(`${TOKEN_COOKIE}=${nearlyDead}; ${SESSION_COOKIE}=refresh-me`),
      "memo",
    );
    expect(minted?.token).toBe(fresh);
    expect(minted?.setCookie).toContain(`${TOKEN_COOKIE}=`);
    expect(minted?.setCookie).toContain("Path=/apps/memo");
  });

  it("returns null with no cookies at all", async () => {
    expect(await mintIdToken(request(), "memo")).toBeNull();
    expect(await requireSession(request())).toBeNull();
  });

  it("treats a spent refresh token as signed out rather than an error", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
      }
      return new Response(JSON.stringify({ __type: "NotAuthorizedException" }), { status: 400 });
    });
    await expect(mintIdToken(request(`${SESSION_COOKIE}=spent`), "memo")).resolves.toBeNull();
  });

  it("returns null when the deployment has no user pool configured", async () => {
    delete process.env.STARKEEP_USER_POOL_ID;
    const token = await signJwt(key, idClaims());
    expect(await mintIdToken(request(`${TOKEN_COOKIE}=${token}`), "memo")).toBeNull();
  });

  it("does not accept a token signed for a different pool client", async () => {
    const foreign = await signJwt(key, idClaims({ aud: "another-client" }));
    expect(await requireSession(request(`${TOKEN_COOKIE}=${foreign}`))).toBeNull();
  });
});
