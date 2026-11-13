/**
 * Serving outside clients: a route an MCP client, a script or another
 * program calls on the user's behalf.
 *
 * In the cloud, the user creates a delegation token on the platform's
 * consent page (`/connect`, on the gateway's own hostname) and gives it to
 * the outside client, which sends it as `Authorization: Bearer skd_...`. The
 * app declares the route with `auth: "delegated"` in its manifest, so the
 * gateway checks the token before the app's code runs. The app then:
 *
 * 1. calls {@link verifyDelegation} to learn whose request this is, and
 * 2. passes the returned `token` to every data call (`signedFetch`'s
 *    `delegation` option or `proxyToDataServer`'s `delegationToken`), so the
 *    platform enforces the delegation's mode and revocation on each one.
 *
 * On the local surface, an app trusts every loopback caller, as it does for
 * its own pages: on-device data belongs to the person at the keyboard. A
 * local endpoint therefore grants full app power to any local process. The
 * same route serves both surfaces.
 */

import { createPublicKey, verify, type KeyObject, type webcrypto } from "node:crypto";
import { localRequestRefusal, type GuardedRequest } from "./local-guard.js";

/** Carries a delegation token from an app server to the data server. */
export const DELEGATION_HEADER = "X-Starkeep-Delegation";
const TOKEN_PREFIX = "skd_";
/** Relative to `STARKEEP_CLOUD_DATA_BASE`, the gateway's own URL. */
const JWKS_PATH = "/connect/jwks.json";
/** How long a fetched key set is trusted before an unknown key id forces a refetch. */
const JWKS_TTL_MS = 60 * 60 * 1000;

export type DelegationMode = "read" | "readwrite";

export interface DelegatedPrincipal {
  surface: "cloud" | "local";
  /** The user the request acts for. Null on the local surface, which names none. */
  userId: string | null;
  delegationId: string | null;
  /** `read` or `readwrite`. Always `readwrite` locally, where loopback is the boundary. */
  mode: DelegationMode;
  /** Forward on every data call. Null on the local surface. */
  token: string | null;
}

interface KeySet {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
}

let keySet: Promise<KeySet> | null = null;

/** Test seam. */
export function resetDelegationKeyCache(): void {
  keySet = null;
}

async function fetchKeySet(base: string): Promise<KeySet> {
  const res = await fetch(`${base.replace(/\/+$/, "")}${JWKS_PATH}`);
  if (!res.ok) throw new Error(`delegation key fetch answered ${res.status}`);
  const body = (await res.json()) as { keys?: (webcrypto.JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.kid !== "string") continue;
    keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
  }
  return { keys, fetchedAt: Date.now() };
}

async function keyFor(base: string, kid: string): Promise<KeyObject | null> {
  const load = (force: boolean): Promise<KeySet> => {
    if (keySet && !force) return keySet;
    const pending = fetchKeySet(base).catch((err: unknown) => {
      // A failed fetch must not be cached, or one network blip locks every
      // outside client out until the container recycles.
      if (keySet === pending) keySet = null;
      throw err;
    });
    keySet = pending;
    return pending;
  };
  let set = await load(false);
  if (!set.keys.has(kid) || Date.now() - set.fetchedAt > JWKS_TTL_MS) set = await load(true);
  return set.keys.get(kid) ?? null;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The claims of a delegation token for `appId`, verified against the
 * deployment's published key, or null. Exported for tests and for an app
 * that receives the token some other way than `Authorization`.
 */
export async function verifyDelegationToken(
  token: string,
  opts: { appId: string; cloudDataBase: string; now?: number },
): Promise<Omit<DelegatedPrincipal, "surface"> | null> {
  try {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const parts = token.slice(TOKEN_PREFIX.length).split(".");
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts as [string, string, string];
    const header = decodeJson(h);
    if (!header || header.alg !== "ES256" || typeof header.kid !== "string") return null;
    const key = await keyFor(opts.cloudDataBase, header.kid);
    if (!key) return null;
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(sig, "base64url"),
    );
    if (!ok) return null;
    const claims = decodeJson(p);
    if (!claims) return null;
    const { sub, aud, sk_dlg, sk_mode, exp } = claims;
    if (aud !== opts.appId) return null;
    if (typeof exp !== "number" || exp * 1000 <= (opts.now ?? Date.now())) return null;
    if (typeof sub !== "string" || !sub || typeof sk_dlg !== "string" || !sk_dlg) return null;
    if (sk_mode !== "read" && sk_mode !== "readwrite") return null;
    return { userId: sub, delegationId: sk_dlg, mode: sk_mode, token };
  } catch {
    return null;
  }
}

/**
 * Who an outside client's request acts for, or null to refuse it.
 *
 * In the cloud: the bearer is a delegation token this deployment signed, for
 * this app, unexpired. The gateway already checked as much; the app checks
 * again because it is about to forward the token, and because a route whose
 * manifest entry says `jwt` by mistake would otherwise trust a header no one
 * checked. The platform checks revocation and the mode on every data call.
 *
 * On the local surface: a loopback request that passes the local guard.
 */
export async function verifyDelegation(req: GuardedRequest): Promise<DelegatedPrincipal | null> {
  if (process.env.STARKEEP_APP_CLIENT_MODE !== "cloud") {
    if (localRequestRefusal(req) !== null) return null;
    return { surface: "local", userId: null, delegationId: null, mode: "readwrite", token: null };
  }
  const appId = process.env.STARKEEP_APP_ID;
  const cloudDataBase = process.env.STARKEEP_CLOUD_DATA_BASE;
  if (!appId || !cloudDataBase) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) return null;
  const verified = await verifyDelegationToken(match[1]!, { appId, cloudDataBase });
  return verified ? { surface: "cloud", ...verified } : null;
}

/**
 * The answer for a request {@link verifyDelegation} refused. The
 * `WWW-Authenticate` header tells an MCP client a bearer token is expected.
 */
export function delegationRefusal(): Response {
  return new Response(JSON.stringify({ error: "A valid delegation token is required" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="starkeep"',
    },
  });
}
