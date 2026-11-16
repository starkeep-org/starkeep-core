/**
 * The OAuth token endpoint, `POST /connect/token`, for public clients.
 *
 * - `authorization_code`: the client exchanges the consent page's code, with
 *   its PKCE verifier, for a fifteen-minute access token and a refresh
 *   token. The exchange creates the delegation row, under the authorization
 *   row's id, with the authorization's sealed Cognito refresh token. A second
 *   use of a code revokes the delegation the first use created.
 * - `refresh_token`: the client presents its refresh token for a new access
 *   token and a new refresh token. The endpoint checks the delegation and runs
 *   phase 1's user check, so a signed-out, disabled or removed user's client
 *   stops at its next refresh. A refresh token presented again after its
 *   rotation is refused. Within {@link ROTATION_GRACE_MS} of the rotation the
 *   refusal is all, because two concurrent refreshes from one client are
 *   common; later, the delegation and every refresh token under it end.
 *
 * The access token is the same `skd_` delegation token a pasted-token
 * delegation carries, so the gateway, the app and the data server check it
 * the same way. Refresh tokens never outlive their delegation.
 *
 * Errors follow RFC 6749, section 5.2.
 */
import { createHash } from "node:crypto";
import { OAUTH_ACCESS_TOKEN_TTL_S } from "@starkeep/protocol-primitives";
import {
  revokeAtCognito,
  type ConnectDeps,
  type ConnectRequest,
  type ConnectResponse,
} from "./connect-pages.js";
import {
  hashRefreshToken,
  mintRefreshToken,
  openRefreshToken,
  signDelegationToken,
  type DelegationSigningKey,
} from "./delegation-tokens.js";
import {
  claimAuthorization,
  endRefreshTokens,
  findAuthorizationByCode,
  findDelegation,
  findRefreshToken,
  insertDelegation,
  insertRefreshToken,
  isLive,
  revokeDelegation,
  rotateRefreshToken,
  type DelegationRow,
} from "./delegation-store.js";
import { checkDelegationUser } from "./delegation-user-check.js";
import { hashCode } from "./oauth-authorize.js";
import { parseResource } from "./oauth-metadata.js";

/** How long after a rotation a repeat of the old refresh token is only refused. */
export const ROTATION_GRACE_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

function json(statusCode: number, body: Record<string, unknown>): ConnectResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
    body: JSON.stringify(body),
  };
}

function oauthError(error: string, description: string, statusCode = 400): ConnectResponse {
  return json(statusCode, { error, error_description: description });
}

/** Whether `verifier` is a PKCE verifier whose S256 challenge is `challenge`. */
export function pkceMatches(verifier: string | null, challenge: string): boolean {
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

/** End a delegation: the row, its refresh tokens, its Cognito refresh token. */
async function endGrant(
  deps: ConnectDeps,
  key: DelegationSigningKey,
  grant: Pick<DelegationRow, "id" | "user_id">,
  now: number,
): Promise<void> {
  const db = await deps.db();
  const row = await revokeDelegation(db, grant.user_id, grant.id, now);
  await endRefreshTokens(db, grant.id, now);
  deps.forgetDelegation(grant.id);
  const refresh = row
    ? openRefreshToken(key.refreshKey, row.id, row.cognito_refresh_ciphertext)
    : null;
  if (refresh) await revokeAtCognito(deps, refresh);
}

/** Issue an access token and a fresh refresh token for a live delegation. */
async function issueTokens(
  deps: ConnectDeps,
  key: DelegationSigningKey,
  grant: DelegationRow,
  now: number,
): Promise<ConnectResponse> {
  const refresh = mintRefreshToken();
  await insertRefreshToken(await deps.db(), {
    token_hash: refresh.hash,
    grant_id: grant.id,
    app_id: grant.app_id,
    created_at_ms: now,
    expires_at_ms: grant.expires_at_ms,
    rotated_at_ms: null,
  });
  const expiresAtMs = Math.min(now + OAUTH_ACCESS_TOKEN_TTL_S * 1000, grant.expires_at_ms);
  const accessToken = signDelegationToken(key, {
    userId: grant.user_id,
    appId: grant.app_id,
    delegationId: grant.id,
    mode: grant.mode,
    channel: grant.channel,
    expiresAtMs,
    nowMs: now,
  });
  return json(200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.max(0, Math.floor((expiresAtMs - now) / 1000)),
    refresh_token: refresh.token,
    scope: grant.mode,
  });
}

/** Whether a token request's `resource`, when it has one, names the app. */
async function resourceNamesApp(
  deps: ConnectDeps,
  resource: string | null,
  appId: string,
): Promise<boolean> {
  if (resource === null) return true;
  const named = parseResource(resource, await deps.viewerHosts());
  return named !== null && named.appId === appId;
}

async function exchangeCode(
  form: URLSearchParams,
  deps: ConnectDeps,
  key: DelegationSigningKey,
  now: number,
): Promise<ConnectResponse> {
  const code = form.get("code");
  if (!code) return oauthError("invalid_request", "code is required");
  const db = await deps.db();
  const row = await findAuthorizationByCode(db, hashCode(code));
  if (!row || row.mode === null || row.days === null || row.code_expires_at_ms === null) {
    return oauthError("invalid_grant", "The code is not valid");
  }
  if (row.used_at_ms !== null) {
    // A code used twice may have been stolen: end what the first use made.
    await endGrant(deps, key, row, now);
    return oauthError("invalid_grant", "The code was already used");
  }
  if (row.code_expires_at_ms <= now) return oauthError("invalid_grant", "The code has expired");
  if (form.get("client_id") !== row.client_id) {
    return oauthError("invalid_grant", "The code was issued to another client");
  }
  if (form.get("redirect_uri") !== row.redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (!pkceMatches(form.get("code_verifier"), row.code_challenge)) {
    return oauthError("invalid_grant", "The code_verifier does not match the code_challenge");
  }
  const resource = form.get("resource");
  if (resource !== null && resource !== row.resource) {
    return oauthError("invalid_target", "resource does not match the authorization request");
  }
  // The app may have been uninstalled since the consent, and uninstall's
  // delete of its delegations must not be undone by a row created after it.
  if (!(await deps.connectableApps()).some((a) => a.appId === row.app_id)) {
    return oauthError("invalid_grant", "The app no longer serves outside clients");
  }
  if (!(await claimAuthorization(db, row.id, now))) {
    await endGrant(deps, key, row, now);
    return oauthError("invalid_grant", "The code was already used");
  }
  const grant: DelegationRow = {
    id: row.id,
    user_id: row.user_id,
    app_id: row.app_id,
    channel: "app",
    mode: row.mode,
    client_name: row.client_name || new URL(row.client_id).host,
    cognito_refresh_ciphertext: row.cognito_refresh_ciphertext,
    created_at_ms: now,
    expires_at_ms: now + row.days * DAY_MS,
    revoked_at_ms: null,
    last_used_at_ms: null,
    last_write_at_ms: null,
    client_id: row.client_id,
    redirect_host: new URL(row.redirect_uri).host,
  };
  await insertDelegation(db, grant);
  return await issueTokens(deps, key, grant, now);
}

async function refresh(
  form: URLSearchParams,
  deps: ConnectDeps,
  key: DelegationSigningKey,
  now: number,
): Promise<ConnectResponse> {
  const presented = form.get("refresh_token");
  if (!presented) return oauthError("invalid_request", "refresh_token is required");
  const db = await deps.db();
  const token = await findRefreshToken(db, hashRefreshToken(presented));
  if (!token) return oauthError("invalid_grant", "The refresh token is not valid");
  const grant = await findDelegation(db, token.grant_id);
  if (!grant || !isLive(grant, now) || token.expires_at_ms <= now) {
    return oauthError("invalid_grant", "This access was revoked or has expired");
  }
  if (form.get("client_id") !== grant.client_id) {
    return oauthError("invalid_grant", "The refresh token was issued to another client");
  }
  if (token.rotated_at_ms !== null) {
    if (now - token.rotated_at_ms > ROTATION_GRACE_MS) {
      // A rotated token presented long after its rotation may have been
      // stolen: end the access rather than guess which holder is genuine.
      await endGrant(deps, key, grant, now);
    }
    return oauthError("invalid_grant", "The refresh token was already used");
  }
  if (!(await resourceNamesApp(deps, form.get("resource"), grant.app_id))) {
    return oauthError("invalid_target", "resource does not name this access's app");
  }

  const cognitoRefresh = openRefreshToken(
    key.refreshKey,
    grant.id,
    grant.cognito_refresh_ciphertext,
  );
  if (!cognitoRefresh) return oauthError("invalid_grant", "This access was revoked or has expired");
  const check = await checkDelegationUser(grant.id, grant.user_id, cognitoRefresh, {
    pool: deps.pool!,
    cognitoDomain: deps.cognitoDomain!,
    groupsMayUseData: deps.groupsMayUseData,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!check.ok) {
    if (check.reason === "unavailable") {
      return oauthError("temporarily_unavailable", "The sign-in service did not answer", 503);
    }
    if (check.reason === "refused") {
      // Signed out everywhere, disabled or deleted: the access ends.
      await endGrant(deps, key, grant, now);
    }
    return oauthError("invalid_grant", "This account may no longer use its data here");
  }

  if (!(await rotateRefreshToken(db, token.token_hash, now))) {
    // A concurrent refresh with the same token rotated it first.
    return oauthError("invalid_grant", "The refresh token was already used");
  }
  return await issueTokens(deps, key, grant, now);
}

/** `POST /connect/token`. */
export async function handleTokenRequest(
  req: ConnectRequest,
  deps: ConnectDeps,
): Promise<ConnectResponse> {
  try {
    const form = new URLSearchParams(req.body);
    const key = await deps.signingKey();
    if (!key || !deps.pool || !deps.cognitoDomain) {
      return oauthError("temporarily_unavailable", "Outside access is not set up here", 503);
    }
    const now = (deps.now ?? Date.now)();
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") return await exchangeCode(form, deps, key, now);
    if (grantType === "refresh_token") return await refresh(form, deps, key, now);
    return oauthError(
      "unsupported_grant_type",
      "Supported grant types: authorization_code, refresh_token",
    );
  } catch (err) {
    console.error("[oauth] the token endpoint failed:", err);
    return oauthError("temporarily_unavailable", "Try again", 503);
  }
}
