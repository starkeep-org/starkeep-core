/**
 * Delegated access for outside clients.
 *
 * A user approves one outside client, such as Claude Code or a script, to
 * reach one app's data in one mode. The platform stores the approval as a
 * delegation row and issues a token that names the row. The token is a
 * platform-signed JWT behind the `skd_` prefix, so a leak scanner can
 * recognize one.
 *
 * The consent and connections pages answer on the API Gateway's own
 * hostname, never on the shared CloudFront origin where app script runs.
 * CloudFront adds {@link ORIGIN_HEADER} to every request it forwards, which
 * is how the gateway tells the two paths apart: the `Host` header cannot,
 * because CloudFront forwards the gateway's own hostname.
 */

/** Carries a delegation token from an app server to the cloud data server. */
export const DELEGATION_HEADER = "X-Starkeep-Delegation";

/** Every delegation token starts with this. */
export const DELEGATION_TOKEN_PREFIX = "skd_";

/**
 * The header CloudFront adds to every request it forwards to the gateway.
 * The value is a deployment secret. CloudFront replaces a viewer-supplied
 * header of the same name, so a viewer cannot forge or strip it.
 */
export const ORIGIN_HEADER = "x-starkeep-origin";

/** What a delegation may do. The mode narrows the app's grants and never widens them. */
export type DelegationMode = "read" | "readwrite";

export const DELEGATION_MODES: readonly DelegationMode[] = ["read", "readwrite"];

/**
 * Which surface a delegation reaches.
 *
 * - `app`: the app's own endpoint, which signs every data call with the
 *   app's secret beside the token. An outside client holds the token.
 * - `job`: one run of an app's scheduled job. The platform's dispatcher mints
 *   the token for one user's enrollment, and the token works only while that
 *   run holds the enrollment's lease. The app signs every data call with its
 *   secret, as on `app`.
 * - `platform`: a platform-hosted connector. Not built, and the data server
 *   refuses it.
 */
export type DelegationChannel = "app" | "job" | "platform";

/** The consent page, its form's target and the managed login return. */
export const CONNECT_ROUTE = "/connect";
export const CONNECT_APPROVE_ROUTE = "/connect/approve";
export const CONNECT_CALLBACK_ROUTE = "/connect/callback";
/** The public key that verifies delegation tokens, as a JWKS document. */
export const CONNECT_JWKS_ROUTE = "/connect/jwks.json";
/** The user's list of delegations. */
export const CONNECTIONS_ROUTE = "/connections";

const REVOKE_PATTERN = /^\/connections\/([A-Za-z0-9_-]{1,64})\/revoke$/;

/** The revoke action's path for one delegation. */
export function connectionRevokePath(delegationId: string): string {
  return `${CONNECTIONS_ROUTE}/${delegationId}/revoke`;
}

/** The delegation id a revoke path names, or null for any other path. */
export function parseConnectionRevokePath(path: string): string | null {
  return REVOKE_PATTERN.exec(path)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------
//
// An app declares jobs in its manifest. A user enrolls in one job on a
// platform consent page, and the enrollment is the grant. A fixed tick wakes
// the platform's dispatcher, which runs each due enrollment by invoking the
// app's function at {@link JOB_ROUTE_PREFIX} with a `job` token.

/** The path, under `/apps/<appId>`, where the dispatcher runs a job: `/_starkeep/jobs/<name>`. */
export const JOB_ROUTE_PREFIX = "/_starkeep/jobs/";

/** At most this many job runs hold a lease at once, across the deployment. */
export const JOB_SLOTS = 2;

/** A run's lease outlives the handler's timeout by this margin, in seconds. */
export const JOB_LEASE_MARGIN_S = 60;

/** A job name, as the manifest declares it. */
export const JOB_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The job consent page and its form's target. */
export const CONNECT_JOB_ROUTE = "/connect/job";
export const CONNECT_JOB_APPROVE_ROUTE = "/connect/job/approve";

const JOB_ACTION_PATTERN = /^\/connections\/jobs\/([A-Za-z0-9_-]{1,64})\/(revoke|schedule)$/;

/** The path that turns one job enrollment off. */
export function jobRevokePath(enrollmentId: string): string {
  return `${CONNECTIONS_ROUTE}/jobs/${enrollmentId}/revoke`;
}

/** The path that changes one job enrollment's time. */
export function jobSchedulePath(enrollmentId: string): string {
  return `${CONNECTIONS_ROUTE}/jobs/${enrollmentId}/schedule`;
}

/** The enrollment and the action a job path names, or null for any other path. */
export function parseJobActionPath(
  path: string,
): { enrollmentId: string; action: "revoke" | "schedule" } | null {
  const match = JOB_ACTION_PATTERN.exec(path);
  if (!match) return null;
  return { enrollmentId: match[1]!, action: match[2] as "revoke" | "schedule" };
}

/** Whether `path` is one of the consent or connections routes. */
export function isConnectPath(path: string): boolean {
  return (
    path === CONNECT_ROUTE ||
    path.startsWith(`${CONNECT_ROUTE}/`) ||
    path === CONNECTIONS_ROUTE ||
    path.startsWith(`${CONNECTIONS_ROUTE}/`)
  );
}

/** The claims every delegation token carries. */
export interface DelegationClaims {
  /** The user the token acts for. */
  readonly sub: string;
  /** The app the token reaches. */
  readonly aud: string;
  /** The delegation row's id. */
  readonly sk_dlg: string;
  readonly sk_mode: DelegationMode;
  readonly sk_channel: DelegationChannel;
  /** On a `job` token: the job's name. */
  readonly sk_job?: string;
  /** On a `job` token: the run's lease id. */
  readonly sk_run?: string;
  /** Seconds since the epoch. */
  readonly exp: number;
  readonly iat: number;
}

// ---------------------------------------------------------------------------
// OAuth 2.1 for MCP clients
// ---------------------------------------------------------------------------
//
// A hosted connector (claude.ai, ChatGPT) or Claude Code runs the OAuth
// authorization code flow with PKCE instead of pasting a token. The gateway's
// execute-api hostname is the authorization server's issuer, beside the
// consent pages. The app's MCP endpoint, on the CloudFront host, is the
// protected resource. The access token is the same `skd_` delegation token,
// with a short life, and a refresh token renews it.

/** The authorization endpoint. A browser starts the flow here. */
export const CONNECT_AUTHORIZE_ROUTE = "/connect/authorize";
/** The consent page's form target for an OAuth request. */
export const CONNECT_AUTHORIZE_APPROVE_ROUTE = "/connect/authorize/approve";
/** The token endpoint, for both the authorization code and the refresh token grants. */
export const CONNECT_TOKEN_ROUTE = "/connect/token";
/** Authorization server metadata (RFC 8414), on the issuer's host. */
export const OAUTH_AS_METADATA_ROUTE = "/.well-known/oauth-authorization-server";
/**
 * Protected resource metadata (RFC 9728) lives at this prefix followed by the
 * resource's path, on the resource's host:
 * `/.well-known/oauth-protected-resource/apps/<appId>/<path>`.
 */
export const OAUTH_PRM_PREFIX = "/.well-known/oauth-protected-resource";

/** Every refresh token starts with this, so a leak scanner can recognize one. */
export const REFRESH_TOKEN_PREFIX = "skr_";

/** The OAuth scopes. Each names the delegation mode it grants. */
export const OAUTH_SCOPES: readonly DelegationMode[] = DELEGATION_MODES;

/** How long an OAuth access token lives. A refresh renews it. */
export const OAUTH_ACCESS_TOKEN_TTL_S = 15 * 60;
