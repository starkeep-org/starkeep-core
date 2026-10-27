/**
 * When a device's session is live, when it is merely offline, and when it is
 * over.
 *
 * ## The local-first rule this encodes
 *
 * **Nothing waits on the network to decide whether a device is signed in.**
 * {@link loadStoredSession} reads the store and returns. {@link refreshSession}
 * runs afterwards and can only ever *upgrade* the session to live or — on an
 * explicit rejection from the pool — end it. A device that has signed in once
 * works offline from then on.
 *
 * The distinction everything here turns on is *the pool said no* versus *the
 * pool did not answer*. A revoked credential and a tunnel look identical from
 * inside a `catch`, and only one of them should cost a device its session.
 */

import type { DeviceAuthConfig } from "./auth-config.js";
import {
  CognitoError,
  idTokenClaims,
  type AuthTokens,
  type CognitoClient,
} from "./cognito-client.js";

/** What a device keeps across restarts. Only the refresh token and the email. */
export interface StoredSession {
  readonly refreshToken: string;
  readonly email: string | null;
}

/**
 * A refresh token signed out of locally but not yet revoked, and the pool that
 * issued it. A pool revokes only its own tokens and refuses any other with a
 * 4xx, which reads as "already revoked". So a retry has to reach the issuing
 * pool, whichever cloud the device uses by then.
 *
 * `A` is how the host names the pool and client: a desktop keeps the device
 * client's {@link DeviceAuthConfig}, a mobile app the mobile-apps client's.
 */
export interface PendingRevocation<A = DeviceAuthConfig> {
  readonly refreshToken: string;
  readonly auth: A;
}

/** A Cognito client for a pool's client, as the host names it. */
export type CognitoClientFor<A = DeviceAuthConfig> = (auth: A) => CognitoClient;

/**
 * Where a device keeps its session: a `0600` file on a desktop, the secure
 * store on a phone. ID tokens are never stored — they live fifteen minutes and
 * are re-obtained on demand, so writing them down would only leave more copies
 * of a bearer credential at rest.
 */
export interface SessionStore<A = DeviceAuthConfig> {
  read(): Promise<StoredSession | null>;
  write(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
  /** A refresh token signed out of locally but not yet revoked at its pool. */
  readPendingRevocation(): Promise<PendingRevocation<A> | null>;
  writePendingRevocation(pending: PendingRevocation<A>): Promise<void>;
  clearPendingRevocation(): Promise<void>;
}

export interface ActiveSession {
  readonly email: string | null;
  readonly refreshToken: string;
  /**
   * Null when this run has not reached Cognito yet — the refresh is in flight,
   * or there is no network. Not an error state: a device's own library needs no
   * token, and sync asks for one when it needs one.
   */
  readonly tokens: AuthTokens | null;
}

export type RefreshOutcome =
  /** The pool answered and the session is now live. */
  | { readonly kind: "live"; readonly session: ActiveSession }
  /** The pool could not be reached. The session stands, unrefreshed. */
  | { readonly kind: "offline"; readonly reason: string }
  /** The pool rejected the refresh token. The session is over and cleared. */
  | { readonly kind: "rejected"; readonly reason: string }
  /**
   * The store changed while the refresh was in flight: the person signed out,
   * or signed in again. The outcome belongs to a session that no longer
   * exists, so nothing was written or cleared.
   */
  | { readonly kind: "superseded" };

/** The session this device already has. Never touches the network. */
export async function loadStoredSession<A>(store: SessionStore<A>): Promise<ActiveSession | null> {
  const stored = await store.read();
  if (!stored) return null;
  return { email: stored.email, refreshToken: stored.refreshToken, tokens: null };
}

/** The session a completed sign-in produces. */
export function sessionFromTokens(tokens: AuthTokens): ActiveSession {
  return {
    email: idTokenClaims(tokens.idToken).email,
    refreshToken: tokens.refreshToken,
    tokens,
  };
}

/** Keep a completed sign-in, so the device stays signed in across restarts. */
export async function storeSignIn<A>(
  store: SessionStore<A>,
  tokens: AuthTokens,
): Promise<ActiveSession> {
  const session = sessionFromTokens(tokens);
  await store.write({ refreshToken: session.refreshToken, email: session.email });
  return session;
}

/**
 * Get the store ready for a completed sign-in. Run before the new session is
 * written.
 *
 * First it finishes a sign-out still waiting on the pool. The sign-in has just
 * reached a pool, so the network is back, and leaving the old token waiting
 * until the next restart would let a second offline sign-out overwrite it.
 * Then it parks the session this sign-in replaces, at its own pool, and
 * revokes it in the background.
 *
 * One slot still holds one token. When the waiting token's pool stays out of
 * reach through the sign-in, which only a move to another cloud allows, the
 * replaced session takes the slot.
 */
export async function endReplacedSession<A>(
  clientFor: CognitoClientFor<A>,
  store: SessionStore<A>,
  previousAuth: A | null,
): Promise<void> {
  await revokePendingSignOut(clientFor, store).catch(() => undefined);
  const previous = await store.read();
  if (!previous || !previousAuth) return;
  await store.writePendingRevocation({ refreshToken: previous.refreshToken, auth: previousAuth });
  void revokePendingSignOut(clientFor, store).catch(() => undefined);
}

/** Whether the store still holds the session a slow call started from. */
async function stillCurrent<A>(store: SessionStore<A>, session: ActiveSession): Promise<boolean> {
  return (await store.read())?.refreshToken === session.refreshToken;
}

/** Whether an error is the pool's answer that a credential is no good. */
export function isRejection(err: unknown): boolean {
  return err instanceof CognitoError && err.status >= 400 && err.status < 500;
}

export async function refreshSession<A>(
  client: CognitoClient,
  store: SessionStore<A>,
  session: ActiveSession,
): Promise<RefreshOutcome> {
  try {
    const tokens = await client.refresh(session.refreshToken);
    // A sign-out or a new sign-in may have landed while the refresh was in
    // flight. Writing now would undo the first or overwrite the second.
    if (!(await stillCurrent(store, session))) return { kind: "superseded" };
    const email = idTokenClaims(tokens.idToken).email ?? session.email;

    // Written back only when something actually changed. The email is normally
    // learned at sign-in, but a session restored from an older write may not
    // have one, and a refresh is where it turns up.
    if (email !== session.email || tokens.refreshToken !== session.refreshToken) {
      await store.write({ refreshToken: tokens.refreshToken, email });
    }
    return {
      kind: "live",
      session: { email, refreshToken: tokens.refreshToken, tokens },
    };
  } catch (err) {
    // Only a 4xx is the pool saying *this credential is no good* — a 5xx, a DNS
    // failure, a captive portal and a dropped connection all mean "ask again
    // later", and discarding a working refresh token on any of them is how
    // being briefly offline turns into being signed out for good.
    if (isRejection(err)) {
      // The rejection is about this token. A newer sign-in keeps its session.
      if (!(await stillCurrent(store, session))) return { kind: "superseded" };
      await store.clear();
      return { kind: "rejected", reason: (err as Error).message };
    }
    return { kind: "offline", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** What became of the server-side half of a sign-out. */
export type RevocationOutcome =
  /** Nothing was waiting to be revoked. */
  | "none"
  /** The pool ended the sign-in, or refused the token as already unusable. */
  | "revoked"
  /** The pool could not be reached. The token is kept to try again later. */
  | "pending";

/**
 * Sign this device out: locally at once, and at the pool as soon as it answers.
 *
 * Deleting the stored token alone is not a sign-out. The refresh token lasts
 * ten years, and a copy taken earlier would keep working for all of them. So
 * the token is revoked at the pool, which ends this sign-in and only this one;
 * the user's other devices stay signed in.
 *
 * The token is parked as a pending revocation *before* the session is cleared,
 * so a process killed in between leaves a token still to revoke rather than
 * one forgotten while valid.
 */
export async function signOut<A>(
  clientFor: CognitoClientFor<A>,
  store: SessionStore<A>,
  session: StoredSession,
  auth: A,
): Promise<RevocationOutcome> {
  await store.writePendingRevocation({ refreshToken: session.refreshToken, auth });
  await store.clear();
  return revokePendingSignOut(clientFor, store);
}

/**
 * Finish a sign-out that could not reach the pool. Run at start and at every
 * sign-in (see {@link endReplacedSession}), so a device signed out without a
 * network revokes its old token the next time it has one. The token goes to
 * the pool that issued it.
 *
 * Same line as {@link refreshSession}: a 4xx is the pool's answer about this
 * token — revoked now, or already revoked or expired — and either way there is
 * nothing left to do. Anything else is the pool not answering.
 */
export async function revokePendingSignOut<A>(
  clientFor: CognitoClientFor<A>,
  store: SessionStore<A>,
): Promise<RevocationOutcome> {
  const pending = await store.readPendingRevocation();
  if (!pending) return "none";
  try {
    await clientFor(pending.auth).revoke(pending.refreshToken);
  } catch (err) {
    if (!isRejection(err)) return "pending";
  }
  // Only clear what was revoked: a sign-out that parked a newer token while
  // this call was in flight keeps it.
  if ((await store.readPendingRevocation())?.refreshToken === pending.refreshToken) {
    await store.clearPendingRevocation();
  }
  return "revoked";
}
