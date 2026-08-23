/**
 * Cookie mechanics for a cloud app session.
 *
 * The browser never holds a Cognito credential. Sign-in runs server-side and
 * the refresh token comes back only as an `HttpOnly` cookie, so an XSS on the
 * page has nothing durable to steal. What it can reach — the minted ID token —
 * is good for an hour and is itself `HttpOnly`.
 */
import { getRuntimeConfig } from "../runtime-config.js";
import type { MinimalNextRequest } from "../next.js";
import type { PoolConfig } from "./cognito.js";
import { refreshTokens } from "./cognito.js";
import { verifyIdToken, unsafeDecodeExp, type VerifiedClaims } from "./verify.js";

/** The Cognito refresh token. Lives as long as Cognito says it does. */
export const SESSION_COOKIE = "sk_session";
/** A minted Cognito ID token, re-minted from `sk_session` as it nears expiry. */
export const TOKEN_COOKIE = "sk_token";

// Re-mint this far ahead of `exp`, so a token accepted by the middleware is
// not rejected by the gateway a moment later.
const REMINT_WINDOW_S = 60;

/**
 * Cookies are scoped to the app's own mount. Two apps on one CloudFront
 * distribution do not see each other's sessions, and a cookie set by one is
 * not sent to the other.
 */
export function cookiePath(appId: string): string {
  return `/apps/${appId}`;
}

export function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function readCookie(req: MinimalNextRequest, name: string): string | null {
  return parseCookieHeader(req.headers.get("cookie"))[name] ?? null;
}

export interface CookieOptions {
  path: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
}

export function setCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly ?? true) parts.push("HttpOnly");
  if (opts.secure ?? true) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** Both cookies, expired. Sign-out sends these; it does not revoke the token. */
export function clearCookies(appId: string): string[] {
  const path = cookiePath(appId);
  return [
    setCookie(SESSION_COOKIE, "", { path, maxAge: 0 }),
    setCookie(TOKEN_COOKIE, "", { path, maxAge: 0 }),
  ];
}

export function sessionCookie(appId: string, refreshToken: string, maxAge: number): string {
  return setCookie(SESSION_COOKIE, refreshToken, { path: cookiePath(appId), maxAge });
}

export function tokenCookie(appId: string, idToken: string, maxAge: number): string {
  return setCookie(TOKEN_COOKIE, idToken, { path: cookiePath(appId), maxAge });
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
export async function mintIdToken(
  req: MinimalNextRequest,
  appId: string,
): Promise<MintedToken | null> {
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
export async function requireSession(
  req: MinimalNextRequest,
): Promise<VerifiedClaims | null> {
  return (await resolveIdToken(req))?.claims ?? null;
}

/**
 * The common path: verify `sk_token` locally against the pool's JWKS. Only
 * when it is missing, invalid, or within a minute of expiry does this cost a
 * Cognito round trip — minting per request would put one on every data call
 * and spend the account's shared user-pool authentication quota.
 */
async function resolveIdToken(req: MinimalNextRequest): Promise<{
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
