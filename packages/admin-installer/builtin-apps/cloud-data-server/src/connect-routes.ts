/**
 * The consent and connections pages, where a user grants an outside client
 * access to one app's data and ends that access.
 *
 * - `GET /connect?app=<appId>&client=<name>` shows the consent form: the app,
 *   a name for the client, a mode (`read` by default) and an expiry (90 days
 *   by default).
 * - `POST /connect/approve` keeps the form, a PKCE verifier and a `state` in
 *   a short-lived cookie and sends the browser to the managed login page.
 * - `GET /connect/callback` exchanges the code. For a consent, it creates the
 *   delegation, seals the fresh refresh token into the row, and shows the
 *   token once. For the connections list, it sets a short session cookie and
 *   returns to the list.
 * - `GET /connections` lists the user's delegations, and
 *   `POST /connections/<id>/revoke` ends one.
 * - `GET /connect/jwks.json` publishes the public key.
 *
 * Every consent runs its own sign-in, so each delegation keeps its own
 * Cognito refresh token, and revoking one at Cognito ends no other. Managed
 * login signs a user in without a password when a session exists.
 *
 * The pages answer only on the gateway's execute-api hostname. The broker
 * refuses any request that carries the CloudFront origin header before it
 * calls in here, so no app script shares the pages' origin. The pages still
 * set `frame-ancestors 'none'`, and every POST requires a same-origin
 * `Sec-Fetch-Site` (or a matching `Origin`) and a CSRF token.
 *
 * Every failure answers a page that says what went wrong, never a 500.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  CONNECT_APPROVE_ROUTE,
  CONNECT_CALLBACK_ROUTE,
  CONNECT_JWKS_ROUTE,
  CONNECT_ROUTE,
  CONNECTIONS_ROUTE,
  DELEGATION_MODES,
  connectionRevokePath,
  escapeMarkup,
  parseConnectionRevokePath,
  type DelegationMode,
} from "@starkeep/protocol-primitives";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  delegationJwks,
  openRefreshToken,
  sealRefreshToken,
  secretsEqual,
  signDelegationToken,
  type DelegationSigningKey,
} from "./delegation-tokens.js";
import {
  insertDelegation,
  isLive,
  listDelegations,
  newDelegationId,
  revokeDelegation,
  type DelegationRow,
} from "./delegation-store.js";
import { verifyUserToken, type PoolConfig } from "./verify-user-token.js";

const PENDING_COOKIE = "sk_connect";
const PENDING_PATH = CONNECT_ROUTE;
const PENDING_MAX_AGE_S = 600;
const CSRF_COOKIE = "sk_connect_csrf";
const SESSION_COOKIE = "sk_connections";
/** The connections list's own session: one ID token's life. */
const SESSION_MAX_AGE_S = 15 * 60;

export const EXPIRY_DAYS = [7, 30, 90, 365] as const;
export const DEFAULT_EXPIRY_DAYS = 90;
export const DEFAULT_MODE: DelegationMode = "read";

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_CLIENT_NAME = 64;

export interface ConnectableApp {
  appId: string;
  name: string;
}

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
  groupsMayUseData(groups: readonly string[]): boolean;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
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

export function isConnectRoute(method: string, rawPath: string): boolean {
  if (method === "GET") {
    return [CONNECT_ROUTE, CONNECT_CALLBACK_ROUTE, CONNECT_JWKS_ROUTE, CONNECTIONS_ROUTE].includes(
      rawPath,
    );
  }
  if (method === "POST") {
    return rawPath === CONNECT_APPROVE_ROUTE || parseConnectionRevokePath(rawPath) !== null;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cookies, headers and pages
// ---------------------------------------------------------------------------

function cookie(name: string, value: string, path: string, maxAge: number): string {
  return (
    `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax` +
    (maxAge === 0 ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "")
  );
}

function readCookies(header: string | undefined): Record<string, string> {
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

function securityHeaders(cognitoDomain: string | undefined): Record<string, string> {
  const formTargets = cognitoDomain ? `'self' https://${cognitoDomain}` : "'self'";
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      `default-src 'none'; style-src 'unsafe-inline'; form-action ${formTargets}; ` +
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
  "border-bottom:1px solid #ccc}.warn{color:#8a4b00}";

function html(
  deps: Pick<ConnectDeps, "cognitoDomain">,
  status: number,
  title: string,
  body: string,
  cookies: string[] = [],
): ConnectResponse {
  return {
    statusCode: status,
    headers: securityHeaders(deps.cognitoDomain),
    cookies,
    body:
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeMarkup(title)}</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>${STYLE}</style></head><body><h1>${escapeMarkup(title)}</h1>${body}</body></html>`,
  };
}

function message(
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

function redirect(location: string, cookies: string[] = []): ConnectResponse {
  return {
    statusCode: 302,
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

function csrfFor(req: ConnectRequest): { token: string; cookies: string[] } {
  const existing = readCookies(req.cookieHeader)[CSRF_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{32,}$/.test(existing)) return { token: existing, cookies: [] };
  const token = randomBytes(24).toString("base64url");
  return { token, cookies: [cookie(CSRF_COOKIE, token, "/", 60 * 60 * 24)] };
}

function csrfOk(req: ConnectRequest, form: URLSearchParams): boolean {
  const expected = readCookies(req.cookieHeader)[CSRF_COOKIE];
  const got = form.get("csrf");
  return !!expected && !!got && secretsEqual(expected, got);
}

// ---------------------------------------------------------------------------
// Sign-in round trip
// ---------------------------------------------------------------------------

interface PendingConsent {
  kind: "consent";
  state: string;
  verifier: string;
  app: string;
  mode: DelegationMode;
  days: number;
  client: string;
}

interface PendingList {
  kind: "list";
  state: string;
  verifier: string;
}

type Pending = PendingConsent | PendingList;

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function callbackUrl(deps: ConnectDeps): string {
  return `https://${deps.host}${CONNECT_CALLBACK_ROUTE}`;
}

function startSignIn(deps: ConnectDeps, pending: Pending, cookies: string[] = []): ConnectResponse {
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

function newPendingIds(): { state: string; verifier: string } {
  return {
    state: randomBytes(16).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
  };
}

function readPending(req: ConnectRequest): Pending | null {
  const raw = readCookies(req.cookieHeader)[PENDING_COOKIE];
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof p.state !== "string" || typeof p.verifier !== "string") return null;
    if (p.kind === "list") return { kind: "list", state: p.state, verifier: p.verifier };
    if (p.kind !== "consent") return null;
    const form = checkConsentForm({
      app: p.app,
      mode: p.mode,
      days: p.days,
      client: p.client,
    });
    return form.ok
      ? { kind: "consent", state: p.state, verifier: p.verifier, ...form.value }
      : null;
  } catch {
    return null;
  }
}

const clearPending = () => cookie(PENDING_COOKIE, "", PENDING_PATH, 0);

interface Tokens {
  idToken: string;
  refreshToken: string;
  userId: string;
  groups: readonly string[];
}

async function exchangeCode(
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
  return { idToken, refreshToken, userId: claims.sub, groups: claims.groups };
}

/** End one refresh token at Cognito. A failure is logged, not fatal. */
async function revokeAtCognito(deps: ConnectDeps, refreshToken: string): Promise<void> {
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

// ---------------------------------------------------------------------------
// The consent form
// ---------------------------------------------------------------------------

interface ConsentForm {
  app: string;
  mode: DelegationMode;
  days: number;
  client: string;
}

export function checkConsentForm(
  raw: Record<string, unknown>,
): { ok: true; value: ConsentForm } | { ok: false; message: string } {
  const app = raw.app;
  if (typeof app !== "string" || !APP_ID_PATTERN.test(app)) {
    return { ok: false, message: "Pick an app." };
  }
  const mode = raw.mode;
  if (!DELEGATION_MODES.includes(mode as DelegationMode)) {
    return { ok: false, message: "Pick read or read and write." };
  }
  const days = Number(raw.days);
  if (!(EXPIRY_DAYS as readonly number[]).includes(days)) {
    return { ok: false, message: "Pick an expiry." };
  }
  const client = typeof raw.client === "string" ? raw.client.trim() : "";
  if (!client || client.length > MAX_CLIENT_NAME || /[\u0000-\u001f\u007f]/.test(client)) {
    return { ok: false, message: `Name the client in 1 to ${MAX_CLIENT_NAME} characters.` };
  }
  return { ok: true, value: { app, mode: mode as DelegationMode, days, client } };
}

async function consentPage(req: ConnectRequest, deps: ConnectDeps): Promise<ConnectResponse> {
  const apps = await deps.connectableApps();
  if (apps.length === 0) {
    return message(deps, 200, "No installed app serves outside clients yet.");
  }
  const wanted = req.query.app;
  const client = (req.query.client ?? "").slice(0, MAX_CLIENT_NAME);
  const { token, cookies } = csrfFor(req);
  const options = apps
    .map(
      (a) =>
        `<option value="${escapeMarkup(a.appId)}"${a.appId === wanted ? " selected" : ""}>` +
        `${escapeMarkup(a.name)}</option>`,
    )
    .join("");
  const expiry = EXPIRY_DAYS.map(
    (d) => `<option value="${d}"${d === DEFAULT_EXPIRY_DAYS ? " selected" : ""}>${d} days</option>`,
  ).join("");
  const body =
    `<p>Give an outside program, such as an AI assistant or a script, access to one app's ` +
    `data. The program gets a token that works until it expires or you revoke it on ` +
    `<a href="${CONNECTIONS_ROUTE}">your connections</a>.</p>` +
    `<form method="post" action="${CONNECT_APPROVE_ROUTE}">` +
    `<input type="hidden" name="csrf" value="${escapeMarkup(token)}">` +
    `<label for="client">Name of the program</label>` +
    `<input id="client" name="client" required maxlength="${MAX_CLIENT_NAME}" ` +
    `value="${escapeMarkup(client)}" placeholder="Claude Code on my laptop">` +
    `<label for="app">App</label><select id="app" name="app">${options}</select>` +
    `<fieldset><legend>Access</legend>` +
    `<label><input type="radio" name="mode" value="read" checked> Read, and add labels</label>` +
    `<label><input type="radio" name="mode" value="readwrite"> Read and write. The program ` +
    `may also move items to the Trash.</label></fieldset>` +
    `<label for="days">Expires after</label><select id="days" name="days">${expiry}</select>` +
    `<p><button type="submit">Sign in and create the token</button></p></form>`;
  return html(deps, 200, "Connect an outside program", body, cookies);
}

async function approve(req: ConnectRequest, deps: ConnectDeps): Promise<ConnectResponse> {
  if (!sameOriginPost(req.headers, deps.host)) {
    return message(deps, 403, "This request did not come from the consent page.");
  }
  const form = new URLSearchParams(req.body);
  if (!csrfOk(req, form)) {
    return message(deps, 403, "This form has expired. Open the consent page again.");
  }
  const checked = checkConsentForm(Object.fromEntries(form));
  if (!checked.ok) return message(deps, 400, checked.message);
  const apps = await deps.connectableApps();
  if (!apps.some((a) => a.appId === checked.value.app)) {
    return message(deps, 404, `No app called ${checked.value.app} serves outside clients here.`);
  }
  return startSignIn(deps, { kind: "consent", ...newPendingIds(), ...checked.value });
}

// ---------------------------------------------------------------------------
// The callback
// ---------------------------------------------------------------------------

async function callback(req: ConnectRequest, deps: ConnectDeps): Promise<ConnectResponse> {
  const pending = readPending(req);
  if (!pending) {
    return message(deps, 400, "This sign-in has expired or was started elsewhere. Start again.");
  }
  if (!req.query.state || req.query.state !== pending.state) {
    return message(deps, 400, "This sign-in does not match the one this browser started.", [
      clearPending(),
    ]);
  }
  if (req.query.error) {
    return message(
      deps,
      400,
      `Sign-in did not finish: ${req.query.error_description ?? req.query.error}`,
      [clearPending()],
    );
  }
  const code = req.query.code;
  if (!code) return message(deps, 400, "Sign-in returned no code.", [clearPending()]);

  let tokens: Tokens | null;
  try {
    tokens = await exchangeCode(deps, code, pending.verifier);
  } catch (err) {
    console.error("[connect] the token exchange failed:", err);
    return message(deps, 502, "The sign-in service did not answer. Try again.");
  }
  if (!tokens) {
    return message(deps, 400, "Sign-in could not be completed. Start again.", [clearPending()]);
  }
  if (!deps.groupsMayUseData(tokens.groups)) {
    await revokeAtCognito(deps, tokens.refreshToken);
    return message(deps, 403, "This account has no data library on this cloud.", [clearPending()]);
  }

  if (pending.kind === "list") {
    // The list needs only the ID token, so the refresh token ends at once.
    await revokeAtCognito(deps, tokens.refreshToken);
    return redirect(CONNECTIONS_ROUTE, [
      clearPending(),
      cookie(SESSION_COOKIE, tokens.idToken, CONNECTIONS_ROUTE, SESSION_MAX_AGE_S),
    ]);
  }

  const key = await deps.signingKey();
  if (!key) return message(deps, 503, "Outside access is not set up on this cloud yet.");
  const now = (deps.now ?? Date.now)();
  const id = newDelegationId();
  const row: DelegationRow = {
    id,
    user_id: tokens.userId,
    app_id: pending.app,
    channel: "app",
    mode: pending.mode,
    client_name: pending.client,
    cognito_refresh_ciphertext: sealRefreshToken(key.refreshKey, id, tokens.refreshToken),
    created_at_ms: now,
    expires_at_ms: now + pending.days * 24 * 60 * 60 * 1000,
    revoked_at_ms: null,
    last_used_at_ms: null,
    last_write_at_ms: null,
  };
  await insertDelegation(await deps.db(), row);
  const token = signDelegationToken(key, {
    userId: row.user_id,
    appId: row.app_id,
    delegationId: id,
    mode: row.mode,
    channel: row.channel,
    expiresAtMs: row.expires_at_ms,
    nowMs: now,
  });
  const body =
    `<p>${escapeMarkup(pending.client)} may now ${pending.mode === "read" ? "read" : "read and write"} ` +
    `your ${escapeMarkup(pending.app)} data until ${escapeMarkup(new Date(row.expires_at_ms).toDateString())}.</p>` +
    `<p class="warn">Copy the token now. This page shows it once, and anyone holding it ` +
    `reaches the same data.</p>` +
    `<textarea readonly>${escapeMarkup(token)}</textarea>` +
    `<p>Give the program this header on every request to the app's endpoint:</p>` +
    `<p><code>Authorization: Bearer &lt;token&gt;</code></p>` +
    `<p><a href="${CONNECTIONS_ROUTE}">Your connections</a></p>`;
  return html(deps, 200, "Token created", body, [clearPending()]);
}

// ---------------------------------------------------------------------------
// The connections list
// ---------------------------------------------------------------------------

async function sessionUser(req: ConnectRequest, deps: ConnectDeps): Promise<string | null> {
  const idToken = readCookies(req.cookieHeader)[SESSION_COOKIE];
  if (!idToken) return null;
  const claims = await verifyUserToken(idToken, deps.pool!);
  if (!claims || !deps.groupsMayUseData(claims.groups)) return null;
  return claims.sub;
}

function describeRow(row: DelegationRow, now: number): string {
  const status =
    row.revoked_at_ms !== null ? "Revoked" : row.expires_at_ms <= now ? "Expired" : "Active";
  const used =
    row.last_used_at_ms === null ? "Never" : new Date(row.last_used_at_ms).toDateString();
  return (
    `<td>${escapeMarkup(row.client_name)}</td><td>${escapeMarkup(row.app_id)}</td>` +
    `<td>${row.mode === "read" ? "Read" : "Read and write"}</td>` +
    `<td>${escapeMarkup(new Date(row.expires_at_ms).toDateString())}</td>` +
    `<td>${escapeMarkup(used)}</td><td>${status}</td>`
  );
}

async function connectionsPage(req: ConnectRequest, deps: ConnectDeps): Promise<ConnectResponse> {
  const userId = await sessionUser(req, deps);
  if (!userId) return startSignIn(deps, { kind: "list", ...newPendingIds() });
  const rows = await listDelegations(await deps.db(), userId);
  const now = (deps.now ?? Date.now)();
  const { token, cookies } = csrfFor(req);
  const list =
    rows.length === 0
      ? "<p>No outside program has access to your data.</p>"
      : `<table><tr><th>Program</th><th>App</th><th>Access</th><th>Expires</th>` +
        `<th>Last used</th><th>Status</th><th></th></tr>` +
        rows
          .map(
            (row) =>
              `<tr>${describeRow(row, now)}<td>` +
              (isLive(row, now)
                ? `<form method="post" action="${escapeMarkup(connectionRevokePath(row.id))}">` +
                  `<input type="hidden" name="csrf" value="${escapeMarkup(token)}">` +
                  `<button type="submit">Revoke</button></form>`
                : "") +
              `</td></tr>`,
          )
          .join("") +
        `</table>`;
  const body = `${list}<p><a href="${CONNECT_ROUTE}">Connect another program</a></p>`;
  return html(deps, 200, "Your connections", body, cookies);
}

async function revoke(
  req: ConnectRequest,
  deps: ConnectDeps,
  id: string,
): Promise<ConnectResponse> {
  if (!sameOriginPost(req.headers, deps.host)) {
    return message(deps, 403, "This request did not come from the connections page.");
  }
  if (!csrfOk(req, new URLSearchParams(req.body))) {
    return message(deps, 403, "This form has expired. Open your connections again.");
  }
  const userId = await sessionUser(req, deps);
  if (!userId) return redirect(CONNECTIONS_ROUTE);
  const row = await revokeDelegation(await deps.db(), userId, id, (deps.now ?? Date.now)());
  if (row) {
    const key = await deps.signingKey();
    const refresh = key
      ? openRefreshToken(key.refreshKey, row.id, row.cognito_refresh_ciphertext)
      : null;
    if (refresh) await revokeAtCognito(deps, refresh);
  }
  return redirect(CONNECTIONS_ROUTE);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Answer one consent or connections route. Call only when {@link isConnectRoute} holds. */
export async function handleConnectRoute(
  req: ConnectRequest,
  deps: ConnectDeps,
): Promise<ConnectResponse> {
  try {
    if (req.method === "GET" && req.rawPath === CONNECT_JWKS_ROUTE) {
      const key = await deps.signingKey();
      if (!key)
        return { statusCode: 503, headers: { "Content-Type": "application/json" }, body: "{}" };
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" },
        body: JSON.stringify(delegationJwks(key)),
      };
    }
    if (!deps.pool || !deps.cognitoDomain) {
      return message(deps, 503, "Outside access is not set up on this cloud yet.");
    }
    if (req.method === "GET" && req.rawPath === CONNECT_ROUTE) return await consentPage(req, deps);
    if (req.method === "POST" && req.rawPath === CONNECT_APPROVE_ROUTE)
      return await approve(req, deps);
    if (req.method === "GET" && req.rawPath === CONNECT_CALLBACK_ROUTE)
      return await callback(req, deps);
    if (req.method === "GET" && req.rawPath === CONNECTIONS_ROUTE) {
      return await connectionsPage(req, deps);
    }
    const revokeId = req.method === "POST" ? parseConnectionRevokePath(req.rawPath) : null;
    if (revokeId) return await revoke(req, deps, revokeId);
    return message(deps, 404, "Not found.");
  } catch (err) {
    console.error("[connect] unexpected failure:", err);
    return message(deps, 503, "This page is unavailable right now. Try again.");
  }
}
