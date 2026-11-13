/**
 * The delegated authorizer: a REQUEST authorizer on app routes declared with
 * `auth: "delegated"`, the routes an outside client such as an MCP client
 * calls with a delegation token.
 *
 * It checks what needs no database: the request came through CloudFront, the
 * bearer is a delegation token this deployment signed, the token has not
 * expired, and the token's `aud` names the app whose route this is. The
 * broker checks the delegation row, the user's groups and the mode on every
 * data call the app then makes, so a token revoked after the authorizer
 * cached its decision reaches app code but no data.
 *
 * The identity sources include the route key beside the bearer, so a cached
 * approval for one app's route never answers for another app's.
 *
 * The context it passes is for the app's logs. The app verifies the token
 * itself before trusting it (`verifyDelegation` in `@starkeep/app-client`),
 * because the app forwards the token to the broker anyway.
 *
 * It never throws: a thrown authorizer is a 500, which reads as an outage.
 */
import { delegationPublicKeyFromPem, verifyDelegationToken } from "./delegation-tokens.js";
import { cameThroughCloudFront } from "./origin-header.js";

interface AuthorizerEvent {
  headers?: Record<string, string | undefined>;
  rawPath?: string;
}

interface SimpleResponse {
  isAuthorized: boolean;
  context?: Record<string, string>;
}

const DENY: SimpleResponse = { isAuthorized: false };

let publicKey: ReturnType<typeof delegationPublicKeyFromPem> | null = null;

function loadPublicKey() {
  if (publicKey) return publicKey;
  const pem = process.env.STARKEEP_DELEGATION_PUBLIC_KEY;
  if (!pem) return null;
  publicKey = delegationPublicKeyFromPem(pem);
  return publicKey;
}

/** Test seam. */
export function resetPublicKeyCache(): void {
  publicKey = null;
}

/** The app a route belongs to: the segment after `/apps/`. */
export function appIdOfPath(rawPath: string | undefined): string | null {
  return /^\/apps\/([^/]+)(\/|$)/.exec(rawPath ?? "")?.[1] ?? null;
}

export async function handler(event: AuthorizerEvent): Promise<SimpleResponse> {
  try {
    const headers = event.headers ?? {};
    if (!cameThroughCloudFront(headers)) return DENY;
    const key = loadPublicKey();
    if (!key) {
      console.error("[delegated-authorizer] no delegation public key configured");
      return DENY;
    }
    const auth = headers["authorization"] ?? headers["Authorization"] ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!match) return DENY;
    const claims = verifyDelegationToken(match[1]!, key);
    if (!claims) return DENY;
    const appId = appIdOfPath(event.rawPath);
    if (!appId || claims.aud !== appId) return DENY;
    return {
      isAuthorized: true,
      context: { userId: claims.sub, delegationId: claims.sk_dlg, mode: claims.sk_mode },
    };
  } catch (err) {
    console.error("[delegated-authorizer] unexpected failure:", err);
    return DENY;
  }
}
