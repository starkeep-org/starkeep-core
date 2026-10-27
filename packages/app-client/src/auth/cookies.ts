/**
 * A cloud app session's cookies, and the addresses of the platform's sign-in
 * pages.
 *
 * Two sides write these cookies. The broker's `/auth/callback` sets them when a
 * person comes back from the managed login page, and the app's own session
 * routes re-mint `sk_token` and clear both. So this module imports nothing: the
 * broker bundles it from `@starkeep/app-client/session-cookies` without the
 * rest of the package.
 *
 * The browser never holds a Cognito credential it can read. The refresh token
 * is an `HttpOnly` cookie, so an XSS on the page has nothing durable to steal.
 * What it can reach — the minted ID token — is good for an hour and is itself
 * `HttpOnly`.
 */

/** The Cognito refresh token. Lives as long as Cognito says it does. */
export const SESSION_COOKIE = "sk_session";
/** A minted Cognito ID token, re-minted from `sk_session` as it nears expiry. */
export const TOKEN_COOKIE = "sk_token";

/**
 * The cloud-apps client's refresh tokens last 30 days. The cookie outliving
 * the token would leave a browser presenting a credential Cognito has already
 * stopped honouring, which reads to the user as a broken app rather than a
 * finished session; the reverse just asks them to sign in again.
 */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Where an app page sends a person to sign in: the platform's page. */
export const SIGN_IN_START_PATH = "/auth/start";
/** Where an app page sends a person to sign out of the managed login page too. */
export const SIGN_OUT_PATH = "/auth/sign-out";

/**
 * Cookies are scoped to the app's own mount. Two apps on one CloudFront
 * distribution do not see each other's sessions, and a cookie set by one is
 * not sent to the other.
 */
export function cookiePath(appId: string): string {
  return `/apps/${appId}`;
}

export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed escape in someone else's cookie is not this module's
      // problem, and must not take every other cookie down with it.
    }
  }
  return out;
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
 * The address that signs a person in to `appId` and brings them back to
 * `returnPath`, which must lie under the app's own mount; the platform refuses
 * any other. Same-origin and absolute-path, so it works behind any base URL.
 */
export function signInAddress(appId: string, returnPath: string = `${cookiePath(appId)}/`): string {
  const query = new URLSearchParams({ app: appId, return: returnPath });
  return `${SIGN_IN_START_PATH}?${query.toString()}`;
}

/**
 * The address that signs a person out of `appId` and out of the managed login
 * page, so the next sign-in asks for the password again.
 */
export function signOutAddress(appId: string): string {
  return `${SIGN_OUT_PATH}?${new URLSearchParams({ app: appId }).toString()}`;
}
