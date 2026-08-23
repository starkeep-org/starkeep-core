/**
 * Cognito ID token verification for the cloud-data-server artifact.
 *
 * This mirrors `@starkeep/app-client/auth/verify` by hand, the same way
 * `api-handler.ts` mirrors the HMAC header literals: this bundle is a
 * separately-deployed Lambda artifact built by esbuild from this directory and
 * cannot import the package. It does not need to be mirrored *twice*, though —
 * the session authorizer and the broker both live here, so they share this.
 *
 * Every failure path returns null rather than throwing. On the auth path a
 * thrown error becomes a 500, and a 500 is indistinguishable from an outage
 * where a refusal is what happened.
 */
import type { webcrypto } from "node:crypto";

type CryptoKey = webcrypto.CryptoKey;

export interface UserClaims {
  /** The Cognito user id. This is the named person behind the request. */
  sub: string;
  email?: string;
  exp: number;
}

export interface PoolConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let keySetPromise: Promise<Map<string, CryptoKey>> | null = null;

/** Pool ids come from the Lambda env, which the installer already populates. */
export function userPoolConfig(): PoolConfig | null {
  const region = process.env.AWS_REGION;
  const userPoolId = process.env.STARKEEP_USER_POOL_ID;
  const userPoolClientId = process.env.STARKEEP_USER_POOL_CLIENT_ID;
  if (!region || !userPoolId || !userPoolClientId) return null;
  return { region, userPoolId, userPoolClientId };
}

export function issuerFor(cfg: PoolConfig): string {
  return `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
}

async function fetchKeySet(cfg: PoolConfig): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`${issuerFor(cfg)}/.well-known/jwks.json`);
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

/**
 * One key set per process. Cognito rotates signing keys rarely and publishes
 * the new one before using it, so an unknown `kid` — not a clock — is the
 * signal to re-fetch; a TTL here would just add SSM-shaped latency to a
 * question that has a better trigger.
 */
function getKeySet(cfg: PoolConfig, forceRefresh = false): Promise<Map<string, CryptoKey>> {
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

export async function verifyUserToken(
  token: string,
  cfg: PoolConfig,
): Promise<UserClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const header = decodeJson(headerB64!);
    const payload = decodeJson(payloadB64!);
    if (!header || !payload) return null;
    if (header.alg !== "RS256") return null;
    const kid = header.kid;
    if (typeof kid !== "string") return null;

    let keys = await getKeySet(cfg);
    let key = keys.get(kid);
    if (!key) {
      // One re-fetch on an unknown kid, then give up — so a caller cannot
      // drive unbounded JWKS traffic by inventing kids.
      keys = await getKeySet(cfg, true);
      key = keys.get(kid);
      if (!key) return null;
    }

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      new Uint8Array(Buffer.from(sigB64!, "base64url")),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
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

    return { sub, email: typeof payload.email === "string" ? payload.email : undefined, exp };
  } catch {
    return null;
  }
}
