/**
 * The platform's session authorizer — a REQUEST authorizer on the shared API
 * Gateway that reads the `sk_token` cookie and verifies it against the user
 * pool's JWKS.
 *
 * Why this exists rather than the JWT authorizer beside it: a JWT authorizer
 * reads a bare token from `Authorization`, and a browser navigating to a URL
 * cannot send that header. That limitation is why the first pass at this
 * design concluded the gateway could not gate a browser app at all, and pushed
 * enforcement into the app bundle instead — which is the app gating itself,
 * the assumption that produced the 2026-08 exposure. A REQUEST authorizer can
 * read any header, `Cookie` included, so the gateway can do the job after all.
 *
 * Why the verification logic is duplicated from
 * `@starkeep/app-client/auth/verify`: this is a separately-deployed artifact
 * bundled by esbuild from this directory and cannot import the package, the
 * same way `api-handler.ts` mirrors the HMAC header literals by hand
 * (`app-client/src/sign.ts` says so).
 *
 * It never throws. An authorizer that throws is a 500, and on the auth path a
 * 500 is indistinguishable from an outage — every failure returns
 * `{ isAuthorized: false }` instead.
 */

import type { webcrypto } from "node:crypto";

// The Lambda runtime exposes WebCrypto as the `crypto` global; the type of a
// key it hands back lives under node:crypto rather than in the ES2022 lib this
// package compiles against.
type CryptoKey = webcrypto.CryptoKey;

const TOKEN_COOKIE = "sk_token";

interface AuthorizerEvent {
  headers?: Record<string, string | undefined>;
}

interface SimpleResponse {
  isAuthorized: boolean;
  context?: Record<string, string>;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

const DENY: SimpleResponse = { isAuthorized: false };

// One key set per process. Cognito rotates signing keys rarely and publishes
// the new one before using it, so an unknown `kid` — not a clock — is the
// signal to re-fetch.
let keySetPromise: Promise<Map<string, CryptoKey>> | null = null;

function poolConfig(): { region: string; userPoolId: string; clientId: string } | null {
  const region = process.env.AWS_REGION;
  const userPoolId = process.env.STARKEEP_USER_POOL_ID;
  const clientId = process.env.STARKEEP_USER_POOL_CLIENT_ID;
  if (!region || !userPoolId || !clientId) return null;
  return { region, userPoolId, clientId };
}

async function fetchKeySet(cfg: {
  region: string;
  userPoolId: string;
}): Promise<Map<string, CryptoKey>> {
  const url = `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}/.well-known/jwks.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  return keys;
}

function getKeySet(
  cfg: { region: string; userPoolId: string },
  forceRefresh = false,
): Promise<Map<string, CryptoKey>> {
  if (keySetPromise && !forceRefresh) return keySetPromise;
  const pending = fetchKeySet(cfg).catch((err) => {
    // A failed fetch must not be cached, or one network blip locks the pool
    // out until the container is recycled.
    if (keySetPromise === pending) keySetPromise = null;
    throw err;
  });
  keySetPromise = pending;
  return pending;
}

/** Test seam; not part of the verification path. */
export function resetKeySetCache(): void {
  keySetPromise = null;
}

function base64UrlToBytes(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * Pull one cookie out of a `Cookie` header. Written by hand because the value
 * is a JWT — `=` padding and `.` separators — and a careless split on `=`
 * truncates it.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}

export async function handler(event: AuthorizerEvent): Promise<SimpleResponse> {
  try {
    const cfg = poolConfig();
    if (!cfg) {
      console.error("[session-authorizer] no user pool configured in env");
      return DENY;
    }

    // API Gateway lower-cases header names in the v2 payload, but a caller can
    // still send `Cookie`, so check both rather than trusting one.
    const headers = event.headers ?? {};
    const cookieHeader = headers["cookie"] ?? headers["Cookie"];
    const token = readCookie(cookieHeader, TOKEN_COOKIE);
    if (!token) return DENY;

    const parts = token.split(".");
    if (parts.length !== 3) return DENY;
    const [headerB64, payloadB64, sigB64] = parts;

    const jwtHeader = decodeJson(headerB64!);
    const payload = decodeJson(payloadB64!);
    if (!jwtHeader || !payload) return DENY;
    if (jwtHeader.alg !== "RS256") return DENY;
    const kid = jwtHeader.kid;
    if (typeof kid !== "string") return DENY;

    let keys = await getKeySet(cfg);
    let key = keys.get(kid);
    if (!key) {
      // One re-fetch on an unknown kid, then give up — so a forged header
      // cannot drive unbounded JWKS traffic from an unauthenticated caller.
      keys = await getKeySet(cfg, true);
      key = keys.get(kid);
      if (!key) return DENY;
    }

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(sigB64!),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!ok) return DENY;

    // Claim checks come after the signature check, so an unsigned token never
    // gets as far as having its claims believed for any purpose.
    if (payload.iss !== `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`) {
      return DENY;
    }
    if (payload.aud !== cfg.clientId) return DENY;
    if (payload.token_use !== "id") return DENY;
    const exp = payload.exp;
    if (typeof exp !== "number" || exp * 1000 <= Date.now()) return DENY;
    const sub = payload.sub;
    if (typeof sub !== "string" || !sub) return DENY;

    // The decision is cached by authorizerResultTtlInSeconds, so this context
    // is only as fresh as that window. Nothing downstream authorizes on it —
    // the broker verifies the end-user token itself — so it is here for logs.
    return { isAuthorized: true, context: { sub } };
  } catch (err) {
    console.error("[session-authorizer] unexpected failure:", err);
    return DENY;
  }
}
