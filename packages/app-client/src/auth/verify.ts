/**
 * Cognito ID token verification, edge-safe.
 *
 * `crypto.subtle` and `fetch` only — no `node:crypto`, no AWS SDK. That
 * constraint is not stylistic: OpenNext runs Next middleware in an edge
 * runtime, and the middleware and the API routes must reach the same verdict
 * about the same token, which means one implementation both can load.
 *
 * Every failure path returns `null` rather than throwing. Callers branch on
 * the result; a verifier that throws turns "this token is bad" into "this
 * service is broken", and on the auth path those must not look alike.
 */
import type { PoolConfig } from "./cognito.js";

export interface VerifiedClaims {
  sub: string;
  email?: string;
  /** Seconds since the epoch, as it appears in the token. */
  exp: number;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

interface KeySet {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

// One key set per pool id, for the life of the process. Cognito rotates
// signing keys rarely and publishes the new one before using it, so an
// unknown `kid` — not a clock — is the signal to re-fetch.
const keySets = new Map<string, Promise<KeySet>>();

function jwksUrl(cfg: PoolConfig): string {
  return `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}/.well-known/jwks.json`;
}

export function issuerFor(cfg: PoolConfig): string {
  return `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
}

async function fetchKeySet(cfg: PoolConfig): Promise<KeySet> {
  const res = await fetch(jwksUrl(cfg));
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  return { keys, fetchedAt: Date.now() };
}

/**
 * Concurrent callers share one in-flight fetch: the promise goes into the map
 * before it settles, so N simultaneous verifications cost one round trip.
 */
function getKeySet(cfg: PoolConfig, forceRefresh = false): Promise<KeySet> {
  const existing = keySets.get(cfg.userPoolId);
  if (existing && !forceRefresh) return existing;
  const pending = fetchKeySet(cfg).catch((err) => {
    // A failed fetch must not be cached, or one network blip locks the pool
    // out until the process restarts.
    if (keySets.get(cfg.userPoolId) === pending) keySets.delete(cfg.userPoolId);
    throw err;
  });
  keySets.set(cfg.userPoolId, pending);
  return pending;
}

/** Test seam and operational escape hatch; not part of the verification path. */
export function clearJwksCache(): void {
  keySets.clear();
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

export async function verifyIdToken(
  token: string,
  cfg: PoolConfig,
): Promise<VerifiedClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const header = decodeJson(headerB64);
    const payload = decodeJson(payloadB64);
    if (!header || !payload) return null;
    if (header.alg !== "RS256") return null;
    const kid = header.kid;
    if (typeof kid !== "string") return null;

    let keySet = await getKeySet(cfg);
    let key = keySet.keys.get(kid);
    if (!key) {
      // Unknown `kid` — the pool may have rotated. One re-fetch, then give up,
      // so a forged header cannot drive unbounded JWKS traffic.
      keySet = await getKeySet(cfg, true);
      key = keySet.keys.get(kid);
      if (!key) return null;
    }

    const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(sigB64) as unknown as BufferSource,
      signed as unknown as BufferSource,
    );
    if (!ok) return null;

    // Claim checks come after the signature check, so an unsigned token never
    // gets as far as having its claims believed for any purpose.
    if (payload.iss !== issuerFor(cfg)) return null;
    if (payload.aud !== cfg.userPoolClientId) return null;
    if (payload.token_use !== "id") return null;
    const exp = payload.exp;
    if (typeof exp !== "number" || exp * 1000 <= Date.now()) return null;
    const sub = payload.sub;
    if (typeof sub !== "string" || !sub) return null;

    return {
      sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      exp,
    };
  } catch {
    return null;
  }
}

/**
 * Claims without verification, for deciding whether a token is close enough to
 * expiry to be worth re-minting. Never use this to authorize anything.
 */
export function unsafeDecodeExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = decodeJson(parts[1]);
  const exp = payload?.exp;
  return typeof exp === "number" ? exp : null;
}
