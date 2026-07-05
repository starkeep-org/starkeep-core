/**
 * Detection for "the AWS session credentials handed to a spawned installer were
 * rejected" — the class of failure whose only remedy is to re-authenticate and
 * retry. The install routes stream child stdout/stderr line-by-line and scan
 * for these signatures so they can surface the friendly "sign in again" message
 * (SSE `code: "EXPIRED_TOKEN"`, which the CloudSetupWizard uses to send the user
 * back to the sign-in step) instead of a raw stack trace.
 *
 * Two distinct surfaces produce this class of failure:
 *   1. The AWS SDK, when an STS session token is expired ("ExpiredToken"...).
 *   2. Aurora DSQL, when it refuses a DbConnect auth token minted from
 *      expired/invalid IAM credentials. This surfaces as the pg driver's
 *      connection error text ("unable to accept connection, access denied"),
 *      NOT any AWS SDK ExpiredToken string — the installer's first
 *      credential-consuming call is the DSQL registry connection, so stale
 *      credentials show up here rather than as an SDK error.
 */
export const CREDENTIAL_FAILURE_SIGNATURES = [
  "ExpiredToken",
  "ExpiredTokenException",
  "The security token included in the request is expired",
  "unable to accept connection, access denied",
];

export function isCredentialFailureLine(line: string): boolean {
  return CREDENTIAL_FAILURE_SIGNATURES.some((sig) => line.includes(sig));
}
