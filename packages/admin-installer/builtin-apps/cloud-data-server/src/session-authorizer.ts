/**
 * The platform's session authorizer — a REQUEST authorizer on the shared API
 * Gateway that reads the `sk_token` cookie and verifies it against the user
 * pool's JWKS.
 *
 * Why this exists rather than the JWT authorizer beside it: a JWT authorizer
 * reads a bare token from `Authorization`, and a browser navigating to a URL
 * cannot send that header. That limitation is why the first pass at this
 * design concluded the gateway could not gate a browser app at all, and pushed
 * enforcement into the app bundle instead — which is the app gating itself,
 * the assumption that produced the 2026-08 exposure. A REQUEST authorizer can
 * read any header, `Cookie` included, so the gateway can do the job after all.
 *
 * It never throws. An authorizer that throws is a 500, and on the auth path a
 * 500 is indistinguishable from an outage — every failure returns
 * `{ isAuthorized: false }` instead.
 */
import { userPoolConfig, verifyUserToken } from "./verify-user-token.js";

export { resetKeySetCache } from "./verify-user-token.js";

const TOKEN_COOKIE = "sk_token";

interface AuthorizerEvent {
  headers?: Record<string, string | undefined>;
}

interface SimpleResponse {
  isAuthorized: boolean;
  context?: Record<string, string>;
}

const DENY: SimpleResponse = { isAuthorized: false };

/**
 * Pull one cookie out of a `Cookie` header. Written by hand because the value
 * is a JWT — `=` padding and `.` separators — and a careless split on `=`
 * truncates it.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}

export async function handler(event: AuthorizerEvent): Promise<SimpleResponse> {
  try {
    const cfg = userPoolConfig();
    if (!cfg) {
      console.error("[session-authorizer] no user pool configured in env");
      return DENY;
    }

    // API Gateway lower-cases header names in the v2 payload, but a caller can
    // still send `Cookie`, so check both rather than trusting one.
    const headers = event.headers ?? {};
    const token = readCookie(headers["cookie"] ?? headers["Cookie"], TOKEN_COOKIE);
    if (!token) return DENY;

    const claims = await verifyUserToken(token, cfg);
    if (!claims) return DENY;

    // The decision is cached by authorizerResultTtlInSeconds, so this context
    // is only as fresh as that window. Nothing downstream authorizes on it —
    // the broker verifies the end-user token itself — so it is here for logs.
    return { isAuthorized: true, context: { sub: claims.sub } };
  } catch (err) {
    console.error("[session-authorizer] unexpected failure:", err);
    return DENY;
  }
}
