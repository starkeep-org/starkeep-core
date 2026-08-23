/**
 * A valid end-user token for the suites whose subject is something else.
 *
 * The broker requires a credential bound to a named Cognito user on every
 * data-plane call, with no exemptions — so every test that exercises a route
 * behind that gate has to present one. These suites are about grants, routing
 * and labels rather than about auth, so the token they carry should be one
 * line of setup and then invisible. `handler-auth.test.ts` is where the gate
 * itself is examined.
 *
 * The fixture stubs `fetch` for the JWKS URL only and delegates everything
 * else to the real one, so a suite that fetches for its own reasons keeps
 * working.
 */
import type { webcrypto } from "node:crypto";
import { vi } from "vitest";
import { resetKeySetCache } from "../src/verify-user-token.js";

type CryptoKey = webcrypto.CryptoKey;
type JsonWebKey = webcrypto.JsonWebKey;

export const TEST_REGION = "us-east-1";
export const TEST_POOL_ID = "us-east-1_TESTPOOL";
export const TEST_CLIENT_ID = "test-client-id";

let signingKey: { privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } } | null = null;

async function ensureKey() {
  if (signingKey) return signingKey;
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
  signingKey = {
    privateKey: pair.privateKey,
    jwk: { ...pub, kid: "test-kid", alg: "RS256", use: "sig" },
  };
  return signingKey;
}

export async function mintTestUserToken(
  over: Record<string, unknown> = {},
): Promise<string> {
  const key = await ensureKey();
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.jwk.kid })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: `https://cognito-idp.${TEST_REGION}.amazonaws.com/${TEST_POOL_ID}`,
      aud: TEST_CLIENT_ID,
      token_use: "id",
      sub: "test-user",
      email: "test@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...over,
    }),
  ).toString("base64url");
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${Buffer.from(sig).toString("base64url")}`;
}

/**
 * Point the broker's verifier at a pool this process can sign for. Call from
 * `beforeAll`; the token it returns goes in `X-Starkeep-User-Token`.
 */
export async function installUserTokenFixture(): Promise<{ token: string }> {
  const key = await ensureKey();
  process.env.AWS_REGION = TEST_REGION;
  process.env.STARKEEP_USER_POOL_ID = TEST_POOL_ID;
  process.env.STARKEEP_USER_POOL_CLIENT_ID = TEST_CLIENT_ID;
  resetKeySetCache();

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/.well-known/jwks.json")) {
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
    }
    return realFetch(input as RequestInfo, init);
  });

  return { token: await mintTestUserToken() };
}
