/**
 * A cloud app session at request time: verify `sk_token`, and re-mint it from
 * `sk_session` as it nears expiry. The cookies themselves are `cookies.ts`,
 * which the broker shares.
 */
import { getRuntimeConfig } from "../runtime-config.js";
import type { MinimalRequest } from "../data-proxy.js";
import type { PoolConfig } from "./cognito.js";
import { refreshTokens } from "./cognito.js";
import { verifyIdToken, unsafeDecodeExp, type VerifiedClaims } from "./verify.js";
import { SESSION_COOKIE, TOKEN_COOKIE, parseCookieHeader, tokenCookie } from "./cookies.js";

export {
  SESSION_COOKIE,
  TOKEN_COOKIE,
  SESSION_MAX_AGE_S,
  type CookieOptions,
  cookiePath,
  parseCookieHeader,
  setCookie,
  clearCookies,
  sessionCookie,
  tokenCookie,
  signInAddress,
  signOutAddress,
  SIGN_IN_START_PATH,
  SIGN_OUT_PATH,
} from "./cookies.js";

// Re-mint this far ahead of `exp`, so a token accepted by the middleware is
// not rejected by the gateway a moment later.
const REMINT_WINDOW_S = 60;

export function readCookie(req: MinimalRequest, name: string): string | null {
  return parseCookieHeader(req.headers.get("cookie"))[name] ?? null;
}

/**
 * Pool configuration for the running app. The platform injects these into the
 * handler's env; an app never supplies them.
 */
export function poolConfig(): PoolConfig | null {
  const cfg = getRuntimeConfig();
  if (!cfg.region || !cfg.userPoolId || !cfg.userPoolClientId) return null;
  return {
    region: cfg.region,
    userPoolId: cfg.userPoolId,
    userPoolClientId: cfg.userPoolClientId,
  };
}

export interface MintedToken {
  token: string;
  claims: VerifiedClaims;
  /** Present when the token was re-minted and the cookie must be rewritten. */
  setCookie?: string;
}

/**
 * Resolve the caller's ID token, re-minting it if needed, and report the
 * `Set-Cookie` the caller must echo when a re-mint happened.
 */
export async function mintIdToken(req: MinimalRequest, appId: string): Promise<MintedToken | null> {
  const minted = await resolveIdToken(req);
  if (!minted) return null;
  if (!minted.reminted) return { token: minted.token, claims: minted.claims };
  return {
    token: minted.token,
    claims: minted.claims,
    setCookie: tokenCookie(appId, minted.token, minted.expiresIn),
  };
}

/**
 * Whether a valid end user is behind this request. Callers that only need the
 * verdict use this; it takes no `appId` because it writes no cookie, so a
 * refresh performed here is paid for again on the next request. Route handlers
 * that can set headers should use {@link mintIdToken} instead.
 */
export async function requireSession(req: MinimalRequest): Promise<VerifiedClaims | null> {
  return (await resolveIdToken(req))?.claims ?? null;
}

/**
 * The common path: verify `sk_token` locally against the pool's JWKS. Only
 * when it is missing, invalid, or within a minute of expiry does this cost a
 * Cognito round trip — minting per request would put one on every data call
 * and spend the account's shared user-pool authentication quota.
 */
async function resolveIdToken(req: MinimalRequest): Promise<{
  token: string;
  claims: VerifiedClaims;
  reminted: boolean;
  expiresIn: number;
} | null> {
  const cfg = poolConfig();
  if (!cfg) return null;

  const existing = readCookie(req, TOKEN_COOKIE);
  if (existing) {
    const exp = unsafeDecodeExp(existing);
    const stillFresh = exp !== null && exp - REMINT_WINDOW_S > Date.now() / 1000;
    if (stillFresh) {
      const claims = await verifyIdToken(existing, cfg);
      if (claims) return { token: existing, claims, reminted: false, expiresIn: 0 };
    }
  }

  const refresh = readCookie(req, SESSION_COOKIE);
  if (!refresh) return null;

  let minted;
  try {
    minted = await refreshTokens(cfg, refresh);
  } catch {
    // An expired or revoked refresh token is an ordinary signed-out state,
    // not an error the caller should have to handle.
    return null;
  }

  const claims = await verifyIdToken(minted.idToken, cfg);
  if (!claims) return null;

  return { token: minted.idToken, claims, reminted: true, expiresIn: minted.expiresIn };
}
