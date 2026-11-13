/**
 * The origin authorizer: a REQUEST authorizer on the routes an app answers
 * before sign-in (the shell, `/sign-in`, `/api/session/*`, static pages).
 *
 * Those routes carry no user check, by design: a browser cannot send a token
 * on a navigation. Without any check, though, an app's page and script would
 * also load on the gateway's execute-api hostname, the origin of the consent
 * and connections pages, and a malicious app's script could drive the
 * consent flow there. This authorizer admits only requests that came through
 * CloudFront. See `origin-header.ts`.
 *
 * The identity source is the origin header alone, so API Gateway caches one
 * decision for every request the distribution forwards, and a direct request
 * without the header is refused before this function runs.
 *
 * It never throws: a thrown authorizer is a 500, which reads as an outage.
 */
import { cameThroughCloudFront } from "./origin-header.js";

interface AuthorizerEvent {
  headers?: Record<string, string | undefined>;
}

export async function handler(event: AuthorizerEvent): Promise<{ isAuthorized: boolean }> {
  try {
    return { isAuthorized: cameThroughCloudFront(event.headers ?? {}) };
  } catch (err) {
    console.error("[origin-authorizer] unexpected failure:", err);
    return { isAuthorized: false };
  }
}
