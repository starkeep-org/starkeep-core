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
 *   returns to the list. For an OAuth request, it shows the OAuth consent
 *   page (`oauth-authorize.ts`).
 * - `GET /connect/authorize` and `POST /connect/authorize/approve` serve an
 *   OAuth client's authorization request; see `oauth-authorize.ts`.
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
import {
  CONNECT_APPROVE_ROUTE,
  CONNECT_AUTHORIZE_APPROVE_ROUTE,
  CONNECT_AUTHORIZE_ROUTE,
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
import {
  clearPending,
  cookie,
  csrfFor,
  csrfOk,
  DEFAULT_EXPIRY_DAYS,
  exchangeCode,
  EXPIRY_DAYS,
  html,
  message,
  newPendingIds,
  readCookies,
  readPendingJson,
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
import {
  delegationJwks,
  openRefreshToken,
  sealRefreshToken,
  signDelegationToken,
} from "./delegation-tokens.js";
import {
  insertDelegation,
  isLive,
  listDelegations,
  newDelegationId,
  revokeDelegation,
  type DelegationRow,
} from "./delegation-store.js";
import {
  authorize,
  approveAuthorization,
  oauthCallback,
  readPendingOAuth,
  type PendingOAuth,
} from "./oauth-authorize.js";
import { verifyUserToken } from "./verify-user-token.js";

const SESSION_COOKIE = "sk_connections";
/** The connections list's own session: one ID token's life. */
const SESSION_MAX_AGE_S = 15 * 60;

export { DEFAULT_EXPIRY_DAYS, EXPIRY_DAYS };
export const DEFAULT_MODE: DelegationMode = "read";

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_CLIENT_NAME = 64;

export type { ConnectDeps, ConnectRequest, ConnectResponse } from "./connect-pages.js";
export { sameOriginPost } from "./connect-pages.js";

export function isConnectRoute(method: string, rawPath: string): boolean {
  if (method === "GET") {
    return [
      CONNECT_ROUTE,
      CONNECT_AUTHORIZE_ROUTE,
      CONNECT_CALLBACK_ROUTE,
      CONNECT_JWKS_ROUTE,
      CONNECTIONS_ROUTE,
    ].includes(rawPath);
  }
  if (method === "POST") {
    return (
      rawPath === CONNECT_APPROVE_ROUTE ||
      rawPath === CONNECT_AUTHORIZE_APPROVE_ROUTE ||
      parseConnectionRevokePath(rawPath) !== null
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// The pending sign-in
// ---------------------------------------------------------------------------

interface PendingConsent extends PendingBase {
  kind: "consent";
  app: string;
  mode: DelegationMode;
  days: number;
  client: string;
}

interface PendingList extends PendingBase {
  kind: "list";
}

type Pending = PendingConsent | PendingList | PendingOAuth;

function readPending(req: ConnectRequest): Pending | null {
  const p = readPendingJson(req);
  if (!p) return null;
  const ids = { state: p.state as string, verifier: p.verifier as string };
  if (p.kind === "list") return { kind: "list", ...ids };
  if (p.kind === "oauth") return readPendingOAuth(p, ids);
  if (p.kind !== "consent") return null;
  const form = checkConsentForm({ app: p.app, mode: p.mode, days: p.days, client: p.client });
  return form.ok ? { kind: "consent", ...ids, ...form.value } : null;
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

  if (pending.kind === "oauth") return await oauthCallback(req, deps, pending, tokens);

  // Checked again here, not only on the form: the app may have been
  // uninstalled during the sign-in, and uninstall's delete of its
  // delegations must not be undone by a row created after it.
  const apps = await deps.connectableApps();
  if (!apps.some((a) => a.appId === pending.app)) {
    await revokeAtCognito(deps, tokens.refreshToken);
    return message(deps, 404, `No app called ${pending.app} serves outside clients here.`, [
      clearPending(),
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
    deps.forgetDelegation(row.id);
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
    if (req.method === "GET" && req.rawPath === CONNECT_AUTHORIZE_ROUTE)
      return await authorize(req, deps);
    if (req.method === "POST" && req.rawPath === CONNECT_AUTHORIZE_APPROVE_ROUTE)
      return await approveAuthorization(req, deps);
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
