/**
 * A cloud app session, as the platform's `/auth/callback` would leave it.
 *
 * A person signs in to a cloud app on the managed login page, which needs a
 * browser. The suite's non-browser steps sign in through the cloud-apps
 * client's admin password flow instead. That flow needs AWS credentials with
 * `cognito-idp:AdminInitiateAuth`, so it runs on the operator's ambient
 * credentials, as `deleteMember` does; no Starkeep identity holds the grant,
 * and no app can sign in through it.
 */
import {
  AdminInitiateAuthCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { regionFromUserPoolId } from "@starkeep/admin-installer";
import type { TestStackConfig } from "./run-state.js";

export interface CloudAppTokens {
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}

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
  const cognito = new CognitoIdentityProviderClient({
    region: regionFromUserPoolId(config.userPoolId),
  });
  const res = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: config.userPoolId,
      ClientId: clientId,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );
  const result = res.AuthenticationResult;
  if (!result?.IdToken || !result.RefreshToken) {
    throw new Error(
      `cloud-apps sign-in for ${email} returned no session` +
        (res.ChallengeName ? ` (challenge ${res.ChallengeName})` : ""),
    );
  }
  return {
    idToken: result.IdToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}

/** The `Cookie` header a browser sends to an app after `/auth/callback`. */
export function sessionCookieHeader(tokens: CloudAppTokens): string {
  return [
    `sk_session=${encodeURIComponent(tokens.refreshToken)}`,
    `sk_token=${encodeURIComponent(tokens.idToken)}`,
  ].join("; ");
}
