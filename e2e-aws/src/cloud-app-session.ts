/**
 * A cloud app session, as the platform's `/auth/callback` would leave it.
 *
 * A person signs in to a cloud app on the managed login page, which needs a
 * browser. The suite's non-browser steps sign in through the cloud-apps
 * client with a password instead (`password-sign-in.ts`).
 */
import type { TestStackConfig } from "./run-state.js";
import { passwordSignIn, type PoolTokens } from "./password-sign-in.js";

export type CloudAppTokens = PoolTokens;

/** Sign in through the cloud-apps client, as the managed login page would. */
export async function cloudAppTokens(
  config: TestStackConfig,
  email: string,
  password: string,
): Promise<CloudAppTokens> {
  const clientId = config.cloudAppsUserPoolClientId;
  if (!clientId) {
    throw new Error("config.json has no cloudAppsUserPoolClientId; install the cloud data server");
  }
  return passwordSignIn(config, clientId, { email, password });
}

/** The `Cookie` header a browser sends to an app after `/auth/callback`. */
export function sessionCookieHeader(tokens: CloudAppTokens): string {
  return [
    `sk_session=${encodeURIComponent(tokens.refreshToken)}`,
    `sk_token=${encodeURIComponent(tokens.idToken)}`,
  ].join("; ");
}
