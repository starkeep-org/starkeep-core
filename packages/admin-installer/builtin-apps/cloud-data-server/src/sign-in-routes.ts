/**
 * The platform's sign-in pages for cloud apps.
 *
 * A cloud app is untrusted code, so it must never receive a password: a
 * password an app held would sign in to every other app and, for an admin, to
 * the deployment itself. These routes send the browser to Cognito's managed
 * login page instead, and set the app's session cookies when the browser comes
 * back. App code receives tokens, as `HttpOnly` cookies, and never a password.
 *
 * - `GET /auth/start?app=<appId>&return=<path>` makes a PKCE verifier and a
 *   `state`, keeps both in a short-lived cookie at `/auth`, and redirects to
 *   the managed login page.
 * - `GET /auth/callback` checks `state`, exchanges the code with the verifier,
 *   sets the app's `sk_session` and `sk_token` at `/apps/<appId>`, and returns
 *   the browser to the app.
 * - `GET /auth/sign-out?app=<appId>` clears the app's cookies and ends the
 *   managed login session, without which the next "Sign in" would skip the
 *   password.
 * - `GET /auth/signed-out` is where Cognito returns the browser after that,
 *   and sends it back to the app.
 *
 * The routes live on the shared origin, outside every app's `/apps/<appId>`
 * path, so no app's routes shadow them. Every app shares the origin, so a
 * malicious app's script can already act inside another app's path with that
 * app's cookies ("Cloud apps share one origin" in the plan's risks); these
 * routes add no reach beyond that.
 *
 * Every failure answers a page that says what went wrong, never a 500: on the
 * sign-in path a 500 reads as an outage when a refusal is what happened.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  SESSION_MAX_AGE_S,
  clearCookies,
  cookiePath,
  parseCookieHeader,
  sessionCookie,
  setCookie,
  tokenCookie,
} from "@starkeep/app-client/session-cookies";
import {
  AUTH_CALLBACK_ROUTE,
  AUTH_SIGNED_OUT_ROUTE,
  AUTH_SIGN_OUT_ROUTE,
  AUTH_START_ROUTE,
} from "@starkeep/protocol-primitives";
import { userPoolConfig, verifyUserToken } from "./verify-user-token.js";

/** The sign-in attempt in flight, from `/auth/start` to `/auth/callback`. */
const PENDING_COOKIE = "sk_sign_in";
/** The app a sign-out returns to, from `/auth/sign-out` to `/auth/signed-out`. */
const SIGN_OUT_COOKIE = "sk_sign_out";
const AUTH_COOKIE_PATH = "/auth";
/** Long enough to type a password and set a new one; short enough to go stale. */
const PENDING_MAX_AGE_S = 600;

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Apps with no browser surface, which therefore have no session to start. */
const NO_SESSION_APPS: ReadonlySet<string> = new Set(["starkeep-drive", "cloud-data-server"]);

export interface SignInRouteDeps {
  /** The deployment's browser-facing base, `https://<distribution>`. */
  publicBaseUrl(): Promise<string>;
  /** Whether `appId` names an installed app. */
  isInstalled(appId: string): Promise<boolean>;
  /** Cognito's token endpoint is reached through this. */
  fetch?: typeof globalThis.fetch;
}

export interface SignInRequest {
  method: string;
  rawPath: string;
  query: Record<string, string | undefined>;
  cookieHeader: string | undefined;
}

export interface SignInResponse {
  statusCode: number;
  headers: Record<string, string>;
  /** HTTP API payload v2 sends each entry as its own `Set-Cookie`. */
  cookies?: string[];
  body: string;
}

interface PendingSignIn {
  state: string;
  verifier: string;
  app: string;
  return: string;
}

const SIGN_IN_ROUTES: ReadonlySet<string> = new Set([
  AUTH_START_ROUTE,
  AUTH_CALLBACK_ROUTE,
  AUTH_SIGN_OUT_ROUTE,
  AUTH_SIGNED_OUT_ROUTE,
]);

export function isSignInRoute(method: string, rawPath: string): boolean {
  return method === "GET" && SIGN_IN_ROUTES.has(rawPath);
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** The PKCE challenge for a verifier: SHA-256, base64url, no padding. */
export function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function redirect(location: string, cookies: string[] = []): SignInResponse {
  return {
    statusCode: 302,
    // Per-browser answers that depend on cookies: never a shared cache entry.
    headers: { Location: location, "Cache-Control": "no-store" },
    cookies,
    body: "",
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A plain page saying what went wrong, with a way back when there is one. */
function page(
  status: number,
  message: string,
  backTo?: string,
  cookies: string[] = [],
): SignInResponse {
  const back = backTo ? `<p><a href="${escapeHtml(backTo)}">Back</a></p>` : "";
  return {
    statusCode: status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    cookies,
    body:
      `<!doctype html><html><head><meta charset="utf-8"><title>Starkeep</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
      `<body><p>${escapeHtml(message)}</p>${back}</body></html>`,
  };
}

/**
 * Whether `path` is a same-origin address under the app's own mount. Anything
 * else would make `/auth/callback` an open redirect, or hand one app's
 * sign-in to another app's page.
 */
export function isReturnPathFor(appId: string, path: string): boolean {
  const mount = cookiePath(appId);
  if (path !== mount && !path.startsWith(`${mount}/`) && !path.startsWith(`${mount}?`)) {
    return false;
  }
  // A backslash or a second slash can turn a path into another host in some
  // browsers, and a dot segment can climb out of the mount.
  if (/[\\\s]/.test(path) || path.includes("//")) return false;
  const pathname = path.split(/[?#]/, 1)[0]!;
  return !pathname.split("/").some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === "." || decoded === ".." || decoded.includes("/");
  });
}

function readPending(cookieHeader: string | undefined): PendingSignIn | null {
  const raw = parseCookieHeader(cookieHeader)[PENDING_COOKIE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const { state, verifier, app } = parsed;
    const ret = parsed.return;
    if (
      typeof state !== "string" ||
      typeof verifier !== "string" ||
      typeof app !== "string" ||
      typeof ret !== "string"
    ) {
      return null;
    }
    return { state, verifier, app, return: ret };
  } catch {
    return null;
  }
}

const clearPending = () => setCookie(PENDING_COOKIE, "", { path: AUTH_COOKIE_PATH, maxAge: 0 });

interface SignInSettings {
  domain: string;
  clientId: string;
  callbackUrl: string;
  signedOutUrl: string;
}

/** What every route needs from the deployment, or why sign-in is off. */
async function settings(deps: SignInRouteDeps): Promise<SignInSettings | null> {
  const domain = process.env.STARKEEP_COGNITO_DOMAIN;
  const pool = userPoolConfig();
  if (!domain || !pool) return null;
  const base = (await deps.publicBaseUrl()).replace(/\/+$/, "");
  return {
    domain,
    clientId: pool.userPoolClientId,
    callbackUrl: `${base}${AUTH_CALLBACK_ROUTE}`,
    signedOutUrl: `${base}${AUTH_SIGNED_OUT_ROUTE}`,
  };
}

async function start(req: SignInRequest, deps: SignInRouteDeps): Promise<SignInResponse> {
  const appId = req.query.app ?? "";
  const returnPath = req.query.return ?? `${cookiePath(appId)}/`;
  if (!APP_ID_PATTERN.test(appId) || NO_SESSION_APPS.has(appId)) {
    return page(400, "This sign-in link names no app.");
  }
  if (!isReturnPathFor(appId, returnPath)) {
    return page(400, "This sign-in link returns somewhere outside the app.");
  }
  if (!(await deps.isInstalled(appId))) {
    return page(404, `No app called ${appId} is installed on this cloud.`);
  }
  const cfg = await settings(deps);
  if (!cfg) return page(503, "Sign-in is not set up on this cloud yet.");

  const pending: PendingSignIn = {
    state: base64Url(randomBytes(16)),
    verifier: base64Url(randomBytes(32)),
    app: appId,
    return: returnPath,
  };
  const authorize = new URL(`https://${cfg.domain}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.callbackUrl,
    scope: "openid email",
    state: pending.state,
    code_challenge: pkceChallenge(pending.verifier),
    code_challenge_method: "S256",
  }).toString();
  return redirect(authorize.toString(), [
    setCookie(PENDING_COOKIE, base64Url(Buffer.from(JSON.stringify(pending))), {
      path: AUTH_COOKIE_PATH,
      maxAge: PENDING_MAX_AGE_S,
    }),
  ]);
}

interface TokenAnswer {
  id_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

async function callback(req: SignInRequest, deps: SignInRouteDeps): Promise<SignInResponse> {
  const pending = readPending(req.cookieHeader);
  if (!pending) {
    return page(400, "This sign-in has expired or was started elsewhere. Start it again.");
  }
  const backTo = `${cookiePath(pending.app)}/`;
  if (!req.query.state || req.query.state !== pending.state) {
    return page(400, "This sign-in does not match the one this browser started.", backTo, [
      clearPending(),
    ]);
  }
  if (req.query.error) {
    return page(
      400,
      `Sign-in did not finish: ${req.query.error_description ?? req.query.error}`,
      backTo,
      [clearPending()],
    );
  }
  const code = req.query.code;
  if (!code) return page(400, "Sign-in returned no code.", backTo, [clearPending()]);
  // The cookie came from this browser, which any app on the origin can write
  // to, so its claims are checked again rather than trusted.
  if (!APP_ID_PATTERN.test(pending.app) || !isReturnPathFor(pending.app, pending.return)) {
    return page(400, "This sign-in names no app.", undefined, [clearPending()]);
  }
  const cfg = await settings(deps);
  const pool = userPoolConfig();
  if (!cfg || !pool) return page(503, "Sign-in is not set up on this cloud yet.");

  const doFetch = deps.fetch ?? globalThis.fetch;
  let answer: TokenAnswer;
  try {
    const res = await doFetch(`https://${cfg.domain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        code,
        redirect_uri: cfg.callbackUrl,
        code_verifier: pending.verifier,
      }).toString(),
    });
    answer = (await res.json().catch(() => ({}))) as TokenAnswer;
    if (!res.ok) {
      console.warn(`[sign-in] the token exchange answered ${res.status}`);
      return page(400, "Sign-in could not be completed. Start it again.", backTo, [clearPending()]);
    }
  } catch (err) {
    console.error("[sign-in] the token exchange failed:", err);
    return page(502, "The sign-in service did not answer. Try again.", backTo);
  }
  const idToken = typeof answer.id_token === "string" ? answer.id_token : null;
  const refreshToken = typeof answer.refresh_token === "string" ? answer.refresh_token : null;
  const expiresIn = typeof answer.expires_in === "number" ? answer.expires_in : 3600;
  // Checked as every data-plane call checks it: the cloud-apps client, this
  // pool, an ID token, not expired.
  if (!idToken || !refreshToken || !(await verifyUserToken(idToken, pool))) {
    return page(400, "Sign-in returned an unusable session. Start it again.", backTo, [
      clearPending(),
    ]);
  }
  return redirect(pending.return, [
    clearPending(),
    sessionCookie(pending.app, refreshToken, SESSION_MAX_AGE_S),
    tokenCookie(pending.app, idToken, expiresIn),
  ]);
}

async function signOut(req: SignInRequest, deps: SignInRouteDeps): Promise<SignInResponse> {
  const appId = req.query.app ?? "";
  if (!APP_ID_PATTERN.test(appId) || NO_SESSION_APPS.has(appId)) {
    return page(400, "This sign-out link names no app.");
  }
  const cookies = [
    ...clearCookies(appId),
    setCookie(SIGN_OUT_COOKIE, appId, { path: AUTH_COOKIE_PATH, maxAge: PENDING_MAX_AGE_S }),
  ];
  const cfg = await settings(deps);
  // With no sign-in page to end, clearing the app's cookies is the whole job.
  if (!cfg) return redirect(`${cookiePath(appId)}/`, clearCookies(appId));
  const logout = new URL(`https://${cfg.domain}/logout`);
  logout.search = new URLSearchParams({
    client_id: cfg.clientId,
    logout_uri: cfg.signedOutUrl,
  }).toString();
  return redirect(logout.toString(), cookies);
}

function signedOut(req: SignInRequest): SignInResponse {
  const appId = parseCookieHeader(req.cookieHeader)[SIGN_OUT_COOKIE] ?? "";
  const clear = setCookie(SIGN_OUT_COOKIE, "", { path: AUTH_COOKIE_PATH, maxAge: 0 });
  if (!APP_ID_PATTERN.test(appId) || NO_SESSION_APPS.has(appId)) {
    return page(200, "You are signed out.", undefined, [clear]);
  }
  return redirect(`${cookiePath(appId)}/`, [clear]);
}

/** Answer one of the sign-in routes. Call only when {@link isSignInRoute} holds. */
export async function handleSignInRoute(
  req: SignInRequest,
  deps: SignInRouteDeps,
): Promise<SignInResponse> {
  try {
    switch (req.rawPath) {
      case AUTH_START_ROUTE:
        return await start(req, deps);
      case AUTH_CALLBACK_ROUTE:
        return await callback(req, deps);
      case AUTH_SIGN_OUT_ROUTE:
        return await signOut(req, deps);
      default:
        return signedOut(req);
    }
  } catch (err) {
    console.error("[sign-in] unexpected failure:", err);
    return page(503, "Sign-in is unavailable right now. Try again.");
  }
}
