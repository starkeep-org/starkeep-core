/**
 * What the consent pages share: the request and response shapes, cookies,
 * the CSRF check, page rendering with its security headers, and the managed
 * login round trip.
 *
 * Two flows use these. `connect-routes.ts` serves the pasted-token consent
 * and the connections list. `oauth-authorize.ts` serves an OAuth client's
 * authorization request. Both answer only on the gateway's execute-api
 * hostname; see `connect-routes.ts` for why.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  CONNECT_CALLBACK_ROUTE,
  CONNECT_ROUTE,
  CONNECTIONS_ROUTE,
  escapeMarkup,
} from "@starkeep/protocol-primitives";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import { secretsEqual, type DelegationSigningKey } from "./delegation-tokens.js";
import type { ConnectableApp } from "./delegation-store.js";
import { verifyUserToken, type PoolConfig } from "./verify-user-token.js";
import type { ClientDeps } from "./oauth-clients.js";

export const PENDING_COOKIE = "sk_connect";
const PENDING_PATH = CONNECT_ROUTE;
const PENDING_MAX_AGE_S = 600;
const CSRF_COOKIE = "sk_connect_csrf";

/** The expiries a user may pick for a delegation, in days. */
export const EXPIRY_DAYS = [7, 30, 90, 365] as const;
export const DEFAULT_EXPIRY_DAYS = 90;

export interface ConnectDeps {
  /** The connectors client, or null when the deployment predates it. */
  pool: PoolConfig | null;
  /** The managed login page's host name. */
  cognitoDomain: string | undefined;
  /** The execute-api hostname the request arrived on. */
  host: string;
  signingKey(): Promise<DelegationSigningKey | null>;
  /** A database client as the platform's standing identity, untagged. */
  db(): Promise<DatabaseClient>;
  /** The installed apps that serve outside clients. */
  connectableApps(): Promise<ConnectableApp[]>;
  /** The deployment's browser-facing host names: the resources' hosts. */
  viewerHosts(): Promise<string[]>;
  groupsMayUseData(groups: readonly string[]): boolean;
  /** Drop a revoked delegation from this container's row cache. */
  forgetDelegation(id: string): void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Test seam for the client metadata document fetch. */
  clients?: ClientDeps;
}

export interface ConnectRequest {
  method: string;
  rawPath: string;
  query: Record<string, string | undefined>;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  cookieHeader: string | undefined;
  body: string;
}

export interface ConnectResponse {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
}

// ---------------------------------------------------------------------------
// Cookies, headers and pages
// ---------------------------------------------------------------------------

export function cookie(name: string, value: string, path: string, maxAge: number): string {
  return (
    `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax` +
    (maxAge === 0 ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "")
  );
}

export function readCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    if (out[name] !== undefined) continue;
    try {
      out[name] = decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      // A malformed value is ignored rather than trusted.
    }
  }
  return out;
}

/**
 * The pages' security headers. `formTargets` are origins a form on the page
 * may reach beyond the page itself and the managed login page: an OAuth
 * consent adds the client's redirect origin, because some browsers apply
 * `form-action` to the redirect that follows the approval.
 */
export function securityHeaders(
  cognitoDomain: string | undefined,
  formTargets: readonly string[] = [],
): Record<string, string> {
  const targets = [
    "'self'",
    ...(cognitoDomain ? [`https://${cognitoDomain}`] : []),
    ...formTargets,
  ].join(" ");
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      `default-src 'none'; style-src 'unsafe-inline'; form-action ${targets}; ` +
      `frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

const STYLE =
  "body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;" +
  "line-height:1.5}label{display:block;margin:.75rem 0 .25rem}input,select{font:inherit}" +
  "code,textarea{font-family:ui-monospace,monospace}textarea{width:100%;height:8rem}" +
  "table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.25rem .5rem;" +
  "border-bottom:1px solid #ccc}.warn{color:#8a4b00}dt{font-weight:600}dd{margin:0 0 .5rem}";

export function html(
  deps: Pick<ConnectDeps, "cognitoDomain">,
  status: number,
  title: string,
  body: string,
  cookies: string[] = [],
  formTargets: readonly string[] = [],
): ConnectResponse {
  return {
    statusCode: status,
    headers: securityHeaders(deps.cognitoDomain, formTargets),
    cookies,
    body:
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeMarkup(title)}</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>${STYLE}</style></head><body><h1>${escapeMarkup(title)}</h1>${body}</body></html>`,
  };
}

export function message(
  deps: Pick<ConnectDeps, "cognitoDomain">,
  status: number,
  text: string,
  cookies: string[] = [],
): ConnectResponse {
  return html(
    deps,
    status,
    "Starkeep",
    `<p>${escapeMarkup(text)}</p><p><a href="${CONNECTIONS_ROUTE}">Your connections</a></p>`,
    cookies,
  );
}

export function redirect(location: string, cookies: string[] = [], status = 302): ConnectResponse {
  return {
    statusCode: status,
    headers: { Location: location, "Cache-Control": "no-store" },
    cookies,
    body: "",
  };
}

/**
 * Whether a POST came from this origin. `Sec-Fetch-Site` answers directly in
 * current browsers; an older browser that does not send it must send an
 * `Origin` naming this host.
 */
export function sameOriginPost(headers: Record<string, string | undefined>, host: string): boolean {
  const site = headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin";
  return headers["origin"] === `https://${host}`;
}

export function csrfFor(req: ConnectRequest): { token: string; cookies: string[] } {
  const existing = readCookies(req.cookieHeader)[CSRF_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{32,}$/.test(existing)) return { token: existing, cookies: [] };
  const token = randomBytes(24).toString("base64url");
  return { token, cookies: [cookie(CSRF_COOKIE, token, "/", 60 * 60 * 24)] };
}

export function csrfOk(req: ConnectRequest, form: URLSearchParams): boolean {
  const expected = readCookies(req.cookieHeader)[CSRF_COOKIE];
  const got = form.get("csrf");
  return !!expected && !!got && secretsEqual(expected, got);
}

// ---------------------------------------------------------------------------
// Sign-in round trip
// ---------------------------------------------------------------------------

/**
 * What a sign-in carries through managed login in the pending cookie. Each
 * flow adds its own fields under its own `kind`; `state` and `verifier`
 * belong to the managed login request itself.
 */
export interface PendingBase {
  kind: string;
  state: string;
  verifier: string;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function callbackUrl(deps: ConnectDeps): string {
  return `https://${deps.host}${CONNECT_CALLBACK_ROUTE}`;
}

export function startSignIn(
  deps: ConnectDeps,
  pending: PendingBase,
  cookies: string[] = [],
): ConnectResponse {
  const authorize = new URL(`https://${deps.cognitoDomain}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: deps.pool!.userPoolClientId,
    redirect_uri: callbackUrl(deps),
    scope: "openid email",
    state: pending.state,
    code_challenge: pkceChallenge(pending.verifier),
    code_challenge_method: "S256",
  }).toString();
  return redirect(authorize.toString(), [
    ...cookies,
    cookie(
      PENDING_COOKIE,
      Buffer.from(JSON.stringify(pending)).toString("base64url"),
      PENDING_PATH,
      PENDING_MAX_AGE_S,
    ),
  ]);
}

export function newPendingIds(): { state: string; verifier: string } {
  return {
    state: randomBytes(16).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
  };
}

/** The pending cookie's JSON, or null when it is absent or malformed. */
export function readPendingJson(req: ConnectRequest): Record<string, unknown> | null {
  const raw = readCookies(req.cookieHeader)[PENDING_COOKIE];
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof p !== "object" || p === null) return null;
    const pending = p as Record<string, unknown>;
    if (typeof pending.state !== "string" || typeof pending.verifier !== "string") return null;
    return pending;
  } catch {
    return null;
  }
}

export const clearPending = () => cookie(PENDING_COOKIE, "", PENDING_PATH, 0);

export interface Tokens {
  idToken: string;
  refreshToken: string;
  userId: string;
  email: string | undefined;
  groups: readonly string[];
}

export async function exchangeCode(
  deps: ConnectDeps,
  code: string,
  verifier: string,
): Promise<Tokens | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const res = await doFetch(`https://${deps.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: deps.pool!.userPoolClientId,
      code,
      redirect_uri: callbackUrl(deps),
      code_verifier: verifier,
    }).toString(),
  });
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.warn(`[connect] the token exchange answered ${res.status}`);
    return null;
  }
  const idToken = typeof answer.id_token === "string" ? answer.id_token : null;
  const refreshToken = typeof answer.refresh_token === "string" ? answer.refresh_token : null;
  if (!idToken || !refreshToken) return null;
  const claims = await verifyUserToken(idToken, deps.pool!);
  if (!claims) return null;
  return {
    idToken,
    refreshToken,
    userId: claims.sub,
    email: claims.email,
    groups: claims.groups,
  };
}

/** End one refresh token at Cognito. A failure is logged, not fatal. */
export async function revokeAtCognito(
  deps: Pick<ConnectDeps, "cognitoDomain" | "pool" | "fetch">,
  refreshToken: string,
): Promise<void> {
  try {
    const res = await (deps.fetch ?? globalThis.fetch)(
      `https://${deps.cognitoDomain}/oauth2/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: refreshToken,
          client_id: deps.pool!.userPoolClientId,
        }).toString(),
      },
    );
    if (!res.ok) console.warn(`[connect] revoking a refresh token answered ${res.status}`);
  } catch (err) {
    console.warn("[connect] revoking a refresh token failed:", err);
  }
}
