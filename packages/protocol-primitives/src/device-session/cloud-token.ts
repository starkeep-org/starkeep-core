/**
 * How a device proves itself to the cloud: its Cognito ID token.
 *
 * ## Why a token, and why this one
 *
 * The cloud data plane authenticates servers by HMAC against a per-app secret,
 * and a device must not hold that secret: it is symmetric, so a device holding
 * it **is** the app, and revoking it after a lost device breaks every other
 * client of the app. So a device presents the one credential it already earned
 * by signing in, and the cloud takes a separate branch for a token that arrives
 * with no app signature.
 *
 * The token comes from the pool's **device** app client, never the admin one.
 * That is what lets the cloud accept it alone: cloud app Lambdas forward
 * admin-client tokens and are untrusted code, so the cloud refuses those
 * without an HMAC, and only a device-client token passes the device branch.
 *
 * ## Freshness
 *
 * Device ID tokens live 15 minutes. The sync engine's signing hook is
 * synchronous, so the token is attached in the channel's `fetch` instead, which
 * can await: {@link CloudTokenSource.current} hands back the cached token,
 * refreshing first when it is within {@link REFRESH_MARGIN_MS} of expiry. One
 * refresh is in flight at a time however many requests ask.
 *
 * ## Signing out takes effect at once
 *
 * The stored session is read on every call, not only on refresh. Clear the
 * session and the next request goes out with no token, rather than riding the
 * cache for up to 15 minutes after the person said stop.
 */

import { idTokenClaims, type CognitoClient } from "./cognito-client.js";
import { loadStoredSession, refreshSession, type SessionStore } from "./session.js";

/** The header the cloud data server reads a user's ID token from. */
export const USER_TOKEN_HEADER = "X-Starkeep-User-Token";

/**
 * Refresh this long before expiry. Covers clock skew between device and AWS and
 * a request that starts just before the deadline and lands just after it.
 */
export const REFRESH_MARGIN_MS = 2 * 60_000;

/** Thrown for a data-plane request when the device has no session to send. */
export class SignedOutError extends Error {
  constructor() {
    super("Sign in to sync");
    this.name = "SignedOutError";
  }
}

export interface CloudTokenSource {
  /** A live ID token, or null when the device has no session or the pool ended it. */
  current(): Promise<string | null>;
}

export interface CloudTokenSourceOptions {
  readonly client: CognitoClient;
  readonly store: SessionStore;
  readonly now?: () => number;
  /**
   * Called when the pool rejects the stored refresh token and the session
   * ends, so the host can stop sync and say "Sign in to sync".
   */
  readonly onRejected?: (reason: string) => void;
}

interface Cached {
  readonly idToken: string;
  readonly expiresAtMs: number;
  /** The refresh token it came from. A different stored one means a different sign-in. */
  readonly refreshToken: string;
}

export function createCloudTokenSource(options: CloudTokenSourceOptions): CloudTokenSource {
  const now = options.now ?? Date.now;
  let cached: Cached | null = null;
  let inFlight: Promise<string | null> | null = null;

  async function refresh(): Promise<string | null> {
    const session = await loadStoredSession(options.store);
    if (!session) return null;
    const outcome = await refreshSession(options.client, options.store, session);
    if (outcome.kind !== "live" || !outcome.session.tokens) {
      // "offline" leaves the session standing and the request to fail as a
      // network error, which is what it is; "rejected" has already cleared it.
      cached = null;
      if (outcome.kind === "rejected") options.onRejected?.(outcome.reason);
      return null;
    }
    const idToken = outcome.session.tokens.idToken;
    const expSec = idTokenClaims(idToken).exp;
    cached = {
      idToken,
      // A token with no readable `exp` is used once and refreshed next time.
      expiresAtMs: expSec === null ? now() : expSec * 1000,
      refreshToken: outcome.session.refreshToken,
    };
    return idToken;
  }

  return {
    async current() {
      const stored = await options.store.read();
      if (!stored) {
        cached = null;
        return null;
      }
      if (
        cached
        && cached.refreshToken === stored.refreshToken
        && cached.expiresAtMs - now() > REFRESH_MARGIN_MS
      ) {
        return cached.idToken;
      }
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/**
 * Wrap a channel's `fetch` so every request to the data plane carries the ID
 * token.
 *
 * Only URLs under `channelUrl` get it. The same `fetch` also downloads from
 * presigned S3 and CloudFront URLs, and a bearer credential has no business in
 * a request to either.
 */
export function withUserToken(
  fetchImpl: typeof globalThis.fetch,
  channelUrl: string,
  tokens: CloudTokenSource,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(channelUrl)) return fetchImpl(input, init);
    const token = await tokens.current();
    if (!token) throw new SignedOutError();
    const headers = new Headers(init?.headers);
    headers.set(USER_TOKEN_HEADER, token);
    return fetchImpl(input, { ...init, headers });
  };
}
