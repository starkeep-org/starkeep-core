/**
 * The admin session, as the browser sees it.
 *
 * The session lives in a file on this computer that admin-web's server and the
 * `starkeep` CLI share (`@starkeep/operator/admin-session`). The browser holds
 * no token and no AWS credential: it asks the server whether someone is signed
 * in, starts a sign-in by navigating to `/auth/start`, and the server mints
 * credentials for each action itself.
 */

export interface AdminSessionView {
  signedIn: boolean;
  email: string | null;
  sub: string | null;
  /** When the session ends without another privileged action. */
  expiresAt: string | null;
  /** Whether this admin-web can start a browser sign-in, and why not. */
  browserSignIn: { available: boolean; reason?: string };
}

const SIGNED_OUT: AdminSessionView = {
  signedIn: false,
  email: null,
  sub: null,
  expiresAt: null,
  browserSignIn: { available: false, reason: "admin-web is not answering." },
};

/** The code a route answers with, in a 401, when it needs a sign-in. */
export const NOT_SIGNED_IN = "NOT_SIGNED_IN";

/** A route needed the admin session and found none. */
export class NotSignedInError extends Error {
  readonly code = NOT_SIGNED_IN;
  constructor(message = "Sign in as the Starkeep admin first.") {
    super(message);
    this.name = "NotSignedInError";
  }
}

export async function readAdminSession(): Promise<AdminSessionView> {
  try {
    const res = await fetch("/api/admin-session", { cache: "no-store" });
    if (!res.ok) return SIGNED_OUT;
    return (await res.json()) as AdminSessionView;
  } catch {
    return SIGNED_OUT;
  }
}

/** The current page, for a sign-in to return to. */
function here(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** Where to send the browser to sign in as the admin. */
export function adminSignInUrl(returnTo: string = here()): string {
  return `/auth/start?client=admin&returnTo=${encodeURIComponent(returnTo)}`;
}

/** Where to send the browser to sign this computer in to sync. */
export function syncSignInUrl(returnTo: string = here()): string {
  return `/auth/start?client=device&returnTo=${encodeURIComponent(returnTo)}`;
}

export function startAdminSignIn(returnTo?: string): void {
  window.location.assign(adminSignInUrl(returnTo));
}

export function startSyncSignIn(returnTo?: string): void {
  window.location.assign(syncSignInUrl(returnTo));
}

/** End the admin session for admin-web and the CLI alike. */
export async function signOutAdmin(): Promise<void> {
  await fetch("/api/admin-session/sign-out", { method: "POST" });
}

/** Throw {@link NotSignedInError} for a route's 401 `NOT_SIGNED_IN` answer. */
export async function throwIfNotSignedIn(res: Response): Promise<void> {
  if (res.status !== 401) return;
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: string; error?: string };
  if (body.code === NOT_SIGNED_IN) throw new NotSignedInError(body.error);
}

/**
 * Remove what older admin-web versions kept in this browser: the admin's
 * refresh token and AWS credentials. The server holds the session now.
 */
export function forgetBrowserSession(): void {
  try {
    localStorage.removeItem("starkeep:cloud-credentials");
    localStorage.removeItem("starkeep:cognito-session");
  } catch {
    // Storage blocked: there is nothing to remove.
  }
}
