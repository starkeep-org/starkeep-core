/**
 * The signed-in admin, for a route that acts in the cloud.
 *
 * Routes mint the admin-app role's credentials on the server from the shared
 * session file (`@starkeep/operator/admin-session`), for each action. The
 * browser never holds a refresh token or AWS credentials, and no route takes
 * credentials in its request body. A route that needs a session and finds
 * none answers 401 with the code `NOT_SIGNED_IN`, which the browser turns into
 * a sign-in button.
 */
import {
  adminCredentials,
  SignInRequired,
  type AdminCredentials,
} from "@starkeep/operator/admin-session";

export type { AdminCredentials };

export const NOT_SIGNED_IN = "NOT_SIGNED_IN";

export function signInRequired(message: string): Response {
  return Response.json({ error: message, code: NOT_SIGNED_IN }, { status: 401 });
}

/** Run `fn` as the signed-in admin, or answer 401 when no session lives. */
export async function withAdmin(
  fn: (admin: AdminCredentials) => Promise<Response>,
): Promise<Response> {
  const admin = await requireAdmin();
  return admin instanceof Response ? admin : fn(admin);
}

/**
 * The signed-in admin, or the 401 (or 502) answer to return instead:
 * `const admin = await requireAdmin(); if (admin instanceof Response) return admin;`
 */
export async function requireAdmin(): Promise<AdminCredentials | Response> {
  try {
    return await adminCredentials();
  } catch (err) {
    if (err instanceof SignInRequired) return signInRequired(err.message);
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Could not use the admin session: ${message}` }, { status: 502 });
  }
}

/** The admin's credentials when a session lives, else null, for a route that works either way. */
export async function adminIfSignedIn(): Promise<AdminCredentials | null> {
  try {
    return await adminCredentials();
  } catch (err) {
    if (err instanceof SignInRequired) return null;
    throw err;
  }
}
