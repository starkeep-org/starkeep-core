/**
 * The CloudFront origin header: how the gateway tells a request that came
 * through CloudFront from one sent straight to the execute-api hostname.
 *
 * Two origins serve one gateway. The shared CloudFront origin runs every app's
 * script; the gateway's own execute-api hostname serves the consent and
 * connections pages, which issue credentials that leave the deployment. The
 * `Host` header cannot tell them apart, because CloudFront forwards the
 * gateway's own hostname. So CloudFront adds a secret header to every request
 * it forwards to the gateway, and:
 *
 * - every authorizer in front of an app's browser routes refuses a request
 *   without the header, so no app page or script loads on the execute-api
 *   hostname; and
 * - the broker refuses `/connect*` and `/connections*` with the header (any
 *   value), so the consent pages never load on the shared origin.
 *
 * CloudFront replaces a viewer-supplied header of the same name, so a viewer
 * cannot forge the header through CloudFront or strip it. A direct caller can
 * add the header with a wrong value, which only gets it refused.
 */
import { ORIGIN_HEADER } from "@starkeep/protocol-primitives";
import { secretsEqual } from "./delegation-tokens.js";

/** The header's value, from the authorizer's environment. */
export function originSecret(): string | null {
  const value = process.env.STARKEEP_ORIGIN_SECRET;
  return value && value.length >= 32 ? value : null;
}

function headerValue(headers: Record<string, string | undefined>): string | undefined {
  return headers[ORIGIN_HEADER] ?? headers[ORIGIN_HEADER.toUpperCase()];
}

/**
 * Whether the request came through CloudFront. False when the deployment has
 * no secret configured: refusing beats admitting, because an unset secret
 * would otherwise open every app route on the execute-api hostname.
 */
export function cameThroughCloudFront(headers: Record<string, string | undefined>): boolean {
  const expected = originSecret();
  const got = headerValue(headers);
  if (!expected || !got) return false;
  return secretsEqual(got, expected);
}

/** Whether the request carries the header at all, whatever its value. */
export function carriesOriginHeader(headers: Record<string, string | undefined>): boolean {
  return headerValue(headers) !== undefined;
}
