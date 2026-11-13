/**
 * Whether the user behind a delegation may still use data.
 *
 * A cloud app's ID token carries `cognito:groups` and dies in fifteen
 * minutes, which is how the other branches notice a disabled or removed
 * user. A delegation token lives for months, so it cannot carry that answer.
 * Instead each delegation keeps a refresh token from the connectors client,
 * and the broker mints a fifteen-minute ID token from it and reads the groups
 * there, caching the answer for the ID token's life.
 *
 * Cognito owns account state this way. "Sign out all devices" revokes every
 * refresh token, "Disable" stops refreshes, and group removal shows in the
 * next ID token, so each existing path reaches outside clients with no new
 * code. A refused refresh is final: the caller marks the delegation revoked.
 */
import { verifyUserToken, type PoolConfig } from "./verify-user-token.js";

/** The cached answer ends this long before the ID token it came from. */
const EXPIRY_SKEW_MS = 30_000;

export type UserCheck =
  | { ok: true }
  /** The user is signed in but holds no data library here. */
  | { ok: false; reason: "no-library" }
  /** Cognito refused the refresh token: signed out, disabled or deleted. */
  | { ok: false; reason: "refused" }
  /** Cognito did not answer. Neither admit nor revoke. */
  | { ok: false; reason: "unavailable" };

interface Cached {
  until: number;
  result: UserCheck;
}

const cache = new Map<string, Cached>();

/** Test seam. */
export function resetUserCheckCache(): void {
  cache.clear();
}

export interface UserCheckDeps {
  pool: PoolConfig;
  cognitoDomain: string;
  groupsMayUseData(groups: readonly string[]): boolean;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * Check the user behind delegation `delegationId`, whose stored refresh
 * token is `refreshToken`. The answer is cached per delegation until the
 * minted ID token expires, so a busy client costs one Cognito call per
 * fifteen minutes.
 */
export async function checkDelegationUser(
  delegationId: string,
  userId: string,
  refreshToken: string,
  deps: UserCheckDeps,
): Promise<UserCheck> {
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(delegationId);
  if (hit && hit.until > now) return hit.result;

  const doFetch = deps.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(`https://${deps.cognitoDomain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: deps.pool.userPoolClientId,
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch (err) {
    console.error("[delegation] the token endpoint did not answer:", err);
    return { ok: false, reason: "unavailable" };
  }
  if (res.status === 400 || res.status === 401) {
    // invalid_grant: the refresh token was revoked or the user disabled.
    cache.delete(delegationId);
    return { ok: false, reason: "refused" };
  }
  if (!res.ok) return { ok: false, reason: "unavailable" };
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown };
  const idToken = typeof body.id_token === "string" ? body.id_token : null;
  const claims = idToken ? await verifyUserToken(idToken, deps.pool) : null;
  // A token for another user would mean a row's ciphertext was moved, which
  // the sealing's associated data already prevents. Refuse it all the same.
  if (!claims || claims.sub !== userId) return { ok: false, reason: "refused" };

  const result: UserCheck = deps.groupsMayUseData(claims.groups)
    ? { ok: true }
    : { ok: false, reason: "no-library" };
  cache.set(delegationId, {
    until: claims.exp * 1000 - EXPIRY_SKEW_MS,
    result,
  });
  return result;
}
