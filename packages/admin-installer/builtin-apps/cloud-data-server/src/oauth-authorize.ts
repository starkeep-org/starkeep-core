/**
 * An OAuth client's authorization request: the authorization endpoint, the
 * consent page and the approval.
 *
 * 1. `GET /connect/authorize` checks the client and its redirect URI first.
 *    A failure there renders an error page and never redirects, because the
 *    redirect URI is not yet known to belong to the client. Every later
 *    failure redirects to the client with `error`, `state` and `iss`. A valid
 *    request rides the pending cookie through managed login.
 * 2. The callback (`connect-routes.ts`) checks the request again, stores it
 *    with the sealed Cognito refresh token in a `delegation.authorizations`
 *    row, and shows the consent page. Signing in first lets the page name the
 *    signed-in account.
 * 3. `POST /connect/authorize/approve` stores the hash of a one-minute code
 *    and redirects to the client with it. A denial deletes the row, revokes
 *    the refresh token, and redirects with `error=access_denied`.
 *
 * The client exchanges the code at the token endpoint (`oauth-token.ts`).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  CONNECT_AUTHORIZE_APPROVE_ROUTE,
  CONNECT_AUTHORIZE_ROUTE,
  CONNECTIONS_ROUTE,
  DELEGATION_MODES,
  escapeMarkup,
  OAUTH_SCOPES,
  type DelegationMode,
} from "@starkeep/protocol-primitives";
import {
  clearPending,
  cookie,
  csrfFor,
  csrfOk,
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_DAYS,
  html,
  message,
  newPendingIds,
  readCookies,
  redirect,
  revokeAtCognito,
  sameOriginPost,
  startSignIn,
  type ConnectDeps,
  type ConnectRequest,
  type ConnectResponse,
  type PendingBase,
  type Tokens,
} from "./connect-pages.js";
import { openRefreshToken, sealRefreshToken, secretsEqual } from "./delegation-tokens.js";
import {
  approveAuthorizationRow,
  AUTHORIZATION_TTL_MS,
  deleteAuthorization,
  deleteExpiredAuthorizations,
  findAuthorization,
  insertAuthorization,
  newDelegationId,
  type AuthorizationRow,
  type ConnectableApp,
} from "./delegation-store.js";
import {
  isLoopbackRedirect,
  loadClient,
  redirectOrigin,
  redirectUriMatches,
  type OAuthClient,
} from "./oauth-clients.js";
import { declaresPath, parseResource } from "./oauth-metadata.js";

/** How long an authorization code lives. */
export const CODE_TTL_MS = 60_000;
/** Ties the consent page's form to the browser that signed in. */
const AUTHORIZATION_COOKIE = "sk_oauth_authz";
const MAX_PARAM = 1024;
const CLEANUP_INTERVAL_MS = 60_000;

/** The request parameters the authorization endpoint reads. */
const PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
  "state",
] as const;

type AuthorizeParams = Partial<Record<(typeof PARAMS)[number], string>>;

/** The pending cookie's OAuth kind: the client's raw request, checked again at the callback. */
export interface PendingOAuth extends PendingBase {
  kind: "oauth";
  params: AuthorizeParams;
}

/** A request that passed every check. */
interface ValidRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  requestedScope: string;
  requestedMode: DelegationMode;
  app: ConnectableApp;
  resource: string;
}

type Checked =
  | { kind: "ok"; request: ValidRequest }
  /** Shown to the user: the client or its redirect URI did not check out. */
  | { kind: "page"; status: number; text: string }
  /** Sent back to the client. */
  | { kind: "redirect"; location: string };

function pickParams(source: Record<string, unknown>): AuthorizeParams {
  const out: AuthorizeParams = {};
  for (const name of PARAMS) {
    const value = source[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

export function readPendingOAuth(
  p: Record<string, unknown>,
  ids: { state: string; verifier: string },
): PendingOAuth | null {
  if (typeof p.params !== "object" || p.params === null) return null;
  return { kind: "oauth", ...ids, params: pickParams(p.params as Record<string, unknown>) };
}

/** The issuer: this host, which also serves the authorization server metadata. */
export function issuerOf(deps: Pick<ConnectDeps, "host">): string {
  return `https://${deps.host}`;
}

/** The client's redirect URI with an OAuth response's parameters added. */
export function clientRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

function errorRedirect(
  deps: ConnectDeps,
  redirectUri: string,
  state: string | undefined,
  error: string,
  description: string,
): Checked {
  return {
    kind: "redirect",
    location: clientRedirect(redirectUri, {
      error,
      error_description: description,
      state,
      iss: issuerOf(deps),
    }),
  };
}

async function checkRequest(params: AuthorizeParams, deps: ConnectDeps): Promise<Checked> {
  // The client and its redirect URI first: until both check out, a redirect
  // could carry the user anywhere.
  const loaded = await loadClient(params.client_id, deps.clients);
  if (!loaded.ok) return { kind: "page", status: 400, text: loaded.message };
  const client = loaded.client;
  const redirectUri = params.redirect_uri;
  if (!redirectUri || redirectUri.length > MAX_PARAM) {
    return { kind: "page", status: 400, text: "The request names no redirect_uri." };
  }
  if (!redirectUriMatches(client.redirectUris, redirectUri)) {
    return {
      kind: "page",
      status: 400,
      text: "The redirect_uri is not one the client's metadata document lists.",
    };
  }

  const state = params.state && params.state.length <= MAX_PARAM ? params.state : undefined;
  const fail = (error: string, description: string) =>
    errorRedirect(deps, redirectUri, state, error, description);
  if (params.state && state === undefined) return fail("invalid_request", "state is too long");
  if (params.response_type !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported");
  }
  if (params.code_challenge_method !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  const codeChallenge = params.code_challenge ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return fail("invalid_request", "code_challenge must be a base64url SHA-256 digest");
  }
  const scopes = (params.scope ?? "").split(" ").filter(Boolean);
  if (!scopes.every((s) => (OAUTH_SCOPES as readonly string[]).includes(s))) {
    return fail("invalid_scope", `Supported scopes: ${OAUTH_SCOPES.join(", ")}`);
  }
  const requestedMode: DelegationMode = scopes.includes("readwrite") ? "readwrite" : "read";

  const named = parseResource(params.resource, await deps.viewerHosts());
  if (!named) return fail("invalid_target", "resource must name an app's MCP endpoint here");
  const app = (await deps.connectableApps()).find((a) => a.appId === named.appId);
  if (!app || !declaresPath(app.delegatedPaths, named.subPath)) {
    return fail("invalid_target", "No app here serves outside clients at that resource");
  }
  return {
    kind: "ok",
    request: {
      client,
      redirectUri,
      state,
      codeChallenge,
      requestedScope: scopes.join(" "),
      requestedMode,
      app,
      resource: named.resource,
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let lastCleanupMs = 0;

/** Test seam. */
export function resetAuthorizationCleanup(): void {
  lastCleanupMs = 0;
}

/**
 * Delete expired authorization rows, at most once a minute per container,
 * and revoke the Cognito refresh token of each one no code exchange claimed.
 * Best effort: a failure is logged and the request goes on.
 */
async function cleanUpExpired(deps: ConnectDeps, now: number): Promise<void> {
  if (now - lastCleanupMs < CLEANUP_INTERVAL_MS) return;
  lastCleanupMs = now;
  try {
    const rows = await deleteExpiredAuthorizations(await deps.db(), now);
    const unclaimed = rows.filter((r) => r.used_at_ms === null);
    if (unclaimed.length === 0) return;
    const key = await deps.signingKey();
    if (!key) return;
    for (const row of unclaimed) {
      const refresh = openRefreshToken(key.refreshKey, row.id, row.cognito_refresh_ciphertext);
      if (refresh) await revokeAtCognito(deps, refresh);
    }
  } catch (err) {
    console.warn("[oauth] cleaning up expired authorizations failed:", err);
  }
}

// ---------------------------------------------------------------------------
// The authorization endpoint
// ---------------------------------------------------------------------------

/** `GET /connect/authorize`. */
export async function authorize(req: ConnectRequest, deps: ConnectDeps): Promise<ConnectResponse> {
  const params = pickParams(req.query);
  const checked = await checkRequest(params, deps);
  if (checked.kind === "page") return message(deps, checked.status, checked.text);
  if (checked.kind === "redirect") return redirect(checked.location);
  await cleanUpExpired(deps, (deps.now ?? Date.now)());
  return startSignIn(deps, { kind: "oauth", ...newPendingIds(), params } as PendingOAuth);
}

// ---------------------------------------------------------------------------
// The callback and the consent page
// ---------------------------------------------------------------------------

function hostOf(uri: string): string {
  return new URL(uri).host;
}

function consentPage(
  req: ConnectRequest,
  deps: ConnectDeps,
  row: AuthorizationRow,
  appName: string,
  cookies: string[],
): ConnectResponse {
  const { token, cookies: csrfCookies } = csrfFor(req);
  const clientHost = hostOf(row.client_id);
  const name = row.client_name || clientHost;
  const loopback = isLoopbackRedirect(row.redirect_uri);
  const expiry = EXPIRY_DAYS.map(
    (d) => `<option value="${d}"${d === DEFAULT_EXPIRY_DAYS ? " selected" : ""}>${d} days</option>`,
  ).join("");
  const readwrite = row.requested_scope.split(" ").includes("readwrite");
  const body =
    `<p><strong>${escapeMarkup(name)}</strong> asks for access to your ` +
    `${escapeMarkup(appName)} data.</p>` +
    `<dl>` +
    `<dt>Program</dt><dd>${escapeMarkup(name)}. The program chose this name; ` +
    `Starkeep has not checked it.</dd>` +
    `<dt>Identified by</dt><dd><code>${escapeMarkup(clientHost)}</code></dd>` +
    `<dt>Sends your access to</dt><dd><code>${escapeMarkup(hostOf(row.redirect_uri))}</code>` +
    `${loopback ? " (this computer)" : ""}</dd>` +
    `<dt>App</dt><dd>${escapeMarkup(appName)}</dd>` +
    `<dt>Signed in as</dt><dd>${escapeMarkup(row.user_email || row.user_id)}</dd>` +
    `</dl>` +
    (loopback
      ? `<p class="warn">This program receives its access on your own computer. Any program ` +
        `running there can claim this name. Allow it only if you just started the connection ` +
        `from a program you trust.</p>`
      : "") +
    `<form method="post" action="${CONNECT_AUTHORIZE_APPROVE_ROUTE}">` +
    `<input type="hidden" name="csrf" value="${escapeMarkup(token)}">` +
    `<input type="hidden" name="authorization" value="${escapeMarkup(row.id)}">` +
    `<fieldset><legend>Access</legend>` +
    `<label><input type="radio" name="mode" value="read"${readwrite ? "" : " checked"}> ` +
    `Read, and add labels</label>` +
    `<label><input type="radio" name="mode" value="readwrite"${readwrite ? " checked" : ""}> ` +
    `Read and write. The program may also move items to the Trash.</label></fieldset>` +
    `<label for="days">Expires after</label><select id="days" name="days">${expiry}</select>` +
    `<p><button type="submit" name="decision" value="approve">Allow</button> ` +
    `<button type="submit" name="decision" value="deny">Deny</button></p></form>` +
    `<p>You can end this access at any time on <a href="${CONNECTIONS_ROUTE}">your ` +
    `connections</a>.</p>`;
  return html(
    deps,
    200,
    "Connect an outside program",
    body,
    [...cookies, ...csrfCookies],
    [redirectOrigin(row.redirect_uri)],
  );
}

/**
 * The callback's OAuth kind, after the sign-in and the groups check. Checks
 * the request again, because the app may have gone and the client's
 * document may have changed during the sign-in, then stores the request and
 * shows the consent page.
 */
export async function oauthCallback(
  req: ConnectRequest,
  deps: ConnectDeps,
  pending: PendingOAuth,
  tokens: Tokens,
): Promise<ConnectResponse> {
  const checked = await checkRequest(pending.params, deps);
  if (checked.kind !== "ok") {
    await revokeAtCognito(deps, tokens.refreshToken);
    if (checked.kind === "page") {
      return message(deps, checked.status, checked.text, [clearPending()]);
    }
    return redirect(checked.location, [clearPending()]);
  }
  const key = await deps.signingKey();
  if (!key) {
    await revokeAtCognito(deps, tokens.refreshToken);
    return message(deps, 503, "Outside access is not set up on this cloud yet.", [clearPending()]);
  }
  const r = checked.request;
  const now = (deps.now ?? Date.now)();
  const id = newDelegationId();
  const row: AuthorizationRow = {
    id,
    user_id: tokens.userId,
    user_email: tokens.email ?? "",
    app_id: r.app.appId,
    resource: r.resource,
    client_id: r.client.clientId,
    client_name: r.client.clientName ?? "",
    redirect_uri: r.redirectUri,
    state: r.state ?? null,
    code_challenge: r.codeChallenge,
    requested_scope: r.requestedScope,
    mode: null,
    days: null,
    // Sealed under the row's id, which becomes the grant's id.
    cognito_refresh_ciphertext: sealRefreshToken(key.refreshKey, id, tokens.refreshToken),
    code_hash: null,
    code_expires_at_ms: null,
    created_at_ms: now,
    expires_at_ms: now + AUTHORIZATION_TTL_MS,
    used_at_ms: null,
  };
  await insertAuthorization(await deps.db(), row);
  return consentPage(req, deps, row, r.app.name, [
    clearPending(),
    cookie(AUTHORIZATION_COOKIE, id, CONNECT_AUTHORIZE_ROUTE, AUTHORIZATION_TTL_MS / 1000),
  ]);
}

// ---------------------------------------------------------------------------
// The approval
// ---------------------------------------------------------------------------

/** The SHA-256 of an authorization code, as the row stores it. */
export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("base64url");
}

/** `POST /connect/authorize/approve`. */
export async function approveAuthorization(
  req: ConnectRequest,
  deps: ConnectDeps,
): Promise<ConnectResponse> {
  if (!sameOriginPost(req.headers, deps.host)) {
    return message(deps, 403, "This request did not come from the consent page.");
  }
  const form = new URLSearchParams(req.body);
  if (!csrfOk(req, form)) {
    return message(deps, 403, "This form has expired. Start the connection again.");
  }
  const id = form.get("authorization") ?? "";
  const bound = readCookies(req.cookieHeader)[AUTHORIZATION_COOKIE] ?? "";
  if (!id || !bound || !secretsEqual(id, bound)) {
    return message(
      deps,
      400,
      "This consent page was replaced by a newer one in this browser. Start the connection again.",
    );
  }
  const clearBound = cookie(AUTHORIZATION_COOKIE, "", CONNECT_AUTHORIZE_ROUTE, 0);
  const now = (deps.now ?? Date.now)();
  const db = await deps.db();
  const row = await findAuthorization(db, id);
  if (!row || row.expires_at_ms <= now || row.code_hash !== null) {
    return message(
      deps,
      400,
      "This consent has expired or was already answered. Start the connection again from your program.",
      [clearBound],
    );
  }
  const issuer = issuerOf(deps);
  const state = row.state ?? undefined;

  if (form.get("decision") !== "approve") {
    const deleted = await deleteAuthorization(db, id);
    const key = await deps.signingKey();
    const refresh =
      deleted && key
        ? openRefreshToken(key.refreshKey, deleted.id, deleted.cognito_refresh_ciphertext)
        : null;
    if (refresh) await revokeAtCognito(deps, refresh);
    return redirect(
      clientRedirect(row.redirect_uri, {
        error: "access_denied",
        error_description: "The user denied the request",
        state,
        iss: issuer,
      }),
      [clearBound],
      303,
    );
  }

  const mode = form.get("mode") as DelegationMode;
  const days = Number(form.get("days"));
  if (!DELEGATION_MODES.includes(mode) || !(EXPIRY_DAYS as readonly number[]).includes(days)) {
    return message(deps, 400, "Pick an access level and an expiry.");
  }
  const code = randomBytes(32).toString("base64url");
  const approved = await approveAuthorizationRow(
    db,
    id,
    { mode, days, codeHash: hashCode(code), codeExpiresAtMs: now + CODE_TTL_MS },
    now,
  );
  if (!approved) {
    return message(
      deps,
      400,
      "This consent has expired or was already answered. Start the connection again from your program.",
      [clearBound],
    );
  }
  return redirect(
    clientRedirect(row.redirect_uri, { code, state, iss: issuer }),
    [clearBound],
    303,
  );
}
