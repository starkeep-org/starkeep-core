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

import { CognitoError, idTokenClaims, type AuthTokens, type CognitoClient } from "./cognito-client.js";

/** What a device keeps across restarts. Only the refresh token and the email. */
export interface StoredSession {
  readonly refreshToken: string;
  readonly email: string | null;
}

/**
 * Where a device keeps its session: a `0600` file on a desktop, the secure
 * store on a phone. ID tokens are never stored — they live fifteen minutes and
 * are re-obtained on demand, so writing them down would only leave more copies
 * of a bearer credential at rest.
 */
export interface SessionStore {
  read(): Promise<StoredSession | null>;
  write(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
  /** A refresh token signed out of locally but not yet revoked at the pool. */
  readPendingRevocation(): Promise<string | null>;
  writePendingRevocation(refreshToken: string): Promise<void>;
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
  | { readonly kind: "rejected"; readonly reason: string };

/** The session this device already has. Never touches the network. */
export async function loadStoredSession(store: SessionStore): Promise<ActiveSession | null> {
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
export async function storeSignIn(store: SessionStore, tokens: AuthTokens): Promise<ActiveSession> {
  const session = sessionFromTokens(tokens);
  await store.write({ refreshToken: session.refreshToken, email: session.email });
  return session;
}

/** Whether an error is the pool's answer that a credential is no good. */
export function isRejection(err: unknown): boolean {
  return err instanceof CognitoError && err.status >= 400 && err.status < 500;
}

export async function refreshSession(
  client: CognitoClient,
  store: SessionStore,
  session: ActiveSession,
): Promise<RefreshOutcome> {
  try {
    const tokens = await client.refresh(session.refreshToken);
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
export async function signOut(
  client: CognitoClient,
  store: SessionStore,
  session: StoredSession,
): Promise<RevocationOutcome> {
  await store.writePendingRevocation(session.refreshToken);
  await store.clear();
  return revokePendingSignOut(client, store);
}

/**
 * Finish a sign-out that could not reach the pool. Run at start, so a device
 * signed out without a network revokes its old token the next time it has one.
 *
 * Same line as {@link refreshSession}: a 4xx is the pool's answer about this
 * token — revoked now, or already revoked or expired — and either way there is
 * nothing left to do. Anything else is the pool not answering.
 */
export async function revokePendingSignOut(
  client: CognitoClient,
  store: SessionStore,
): Promise<RevocationOutcome> {
  const pending = await store.readPendingRevocation();
  if (!pending) return "none";
  try {
    await client.revoke(pending);
  } catch (err) {
    if (!isRejection(err)) return "pending";
  }
  // Only clear what was revoked: a sign-out that parked a newer token while
  // this call was in flight keeps it.
  if ((await store.readPendingRevocation()) === pending) await store.clearPendingRevocation();
  return "revoked";
}
