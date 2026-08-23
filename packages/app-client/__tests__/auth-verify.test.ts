/**
 * ID token verification. Each rejection case is listed separately on purpose:
 * a verifier that returns null for the right reason and a verifier that
 * returns null because it fell over are indistinguishable from one assertion,
 * and the positive case below is what tells them apart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyIdToken, clearJwksCache, issuerFor } from "../src/auth/verify.js";
import type { PoolConfig } from "../src/auth/cognito.js";
import { makeKey, signJwt, type TestKey } from "./auth-jwt.js";

const cfg: PoolConfig = {
  region: "us-east-2",
  userPoolId: "us-east-2_TESTPOOL",
  userPoolClientId: "client-abc",
};

let key: TestKey;
let otherKey: TestKey;
let fetchMock: ReturnType<typeof vi.fn>;

function goodClaims(over: Record<string, unknown> = {}) {
  return {
    iss: issuerFor(cfg),
    aud: cfg.userPoolClientId,
    token_use: "id",
    sub: "user-1",
    email: "a@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}

function jwksResponse(keys: TestKey[]): Response {
  return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  key ??= await makeKey("kid-1");
  otherKey ??= await makeKey("kid-2");
  clearJwksCache();
  fetchMock = vi.fn().mockImplementation(async () => jwksResponse([key]));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyIdToken", () => {
  it("accepts a well-formed token signed by a published key", async () => {
    const claims = await verifyIdToken(await signJwt(key, goodClaims()), cfg);
    expect(claims).toEqual({ sub: "user-1", email: "a@example.com", exp: expect.any(Number) });
  });

  it("rejects a wrong issuer", async () => {
    const token = await signJwt(key, goodClaims({ iss: "https://evil.example.com/pool" }));
    expect(await verifyIdToken(token, cfg)).toBeNull();
  });

  it("rejects a wrong audience", async () => {
    const token = await signJwt(key, goodClaims({ aud: "someone-elses-client" }));
    expect(await verifyIdToken(token, cfg)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signJwt(key, goodClaims({ exp: Math.floor(Date.now() / 1000) - 1 }));
    expect(await verifyIdToken(token, cfg)).toBeNull();
  });

  it("rejects an access token where an id token is required", async () => {
    const token = await signJwt(key, goodClaims({ token_use: "access" }));
    expect(await verifyIdToken(token, cfg)).toBeNull();
  });

  it("rejects a signature from a key the pool does not publish", async () => {
    // Signed by `otherKey` but claiming `key`'s kid, so the verifier finds a
    // key to check against and the check is the thing that fails.
    const token = await signJwt({ ...otherKey, kid: key.kid }, goodClaims());
    expect(await verifyIdToken(token, cfg)).toBeNull();
  });

  it("rejects a malformed three-part string", async () => {
    expect(await verifyIdToken("not.a.jwt", cfg)).toBeNull();
    expect(await verifyIdToken("onlytwo.parts", cfg)).toBeNull();
    expect(await verifyIdToken("", cfg)).toBeNull();
  });

  it("rejects an unsigned (alg: none) token outright", async () => {
    const token = await signJwt(key, goodClaims(), { alg: "none" });
    expect(await verifyIdToken(token, cfg)).toBeNull();
  });

  it("fetches the JWKS once across concurrent verifications", async () => {
    const token = await signJwt(key, goodClaims());
    const results = await Promise.all([
      verifyIdToken(token, cfg),
      verifyIdToken(token, cfg),
      verifyIdToken(token, cfg),
    ]);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches the JWKS once on an unknown kid, then gives up", async () => {
    // First key set knows only `key`; the pool then rotates in `otherKey`.
    fetchMock
      .mockImplementationOnce(async () => jwksResponse([key]))
      .mockImplementation(async () => jwksResponse([key, otherKey]));

    const rotated = await signJwt(otherKey, goodClaims());
    expect(await verifyIdToken(rotated, cfg)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A kid nobody publishes must not drive unbounded JWKS traffic: one
    // re-fetch per verification, and no retry loop.
    fetchMock.mockClear();
    const forged = await signJwt({ ...key, kid: "kid-nobody-has" }, goodClaims());
    expect(await verifyIdToken(forged, cfg)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null rather than throwing when the JWKS endpoint is down", async () => {
    fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));
    const token = await signJwt(key, goodClaims());
    await expect(verifyIdToken(token, cfg)).resolves.toBeNull();
  });

  it("does not cache a failed JWKS fetch", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("network");
    });
    const token = await signJwt(key, goodClaims());
    expect(await verifyIdToken(token, cfg)).toBeNull();
    expect(await verifyIdToken(token, cfg)).not.toBeNull();
  });
});
