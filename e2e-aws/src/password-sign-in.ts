/**
 * The suite's password sign-in, for every client of the deployment's pool.
 *
 * People sign in on the managed login page, which needs a browser. The admin,
 * device and cloud-apps clients allow password sign-in only through
 * `ADMIN_USER_PASSWORD_AUTH`, so the suite's non-browser steps sign in that
 * way. The flow needs AWS credentials with `cognito-idp:AdminInitiateAuth`, so
 * it runs on the operator's ambient credentials, as `deleteMember` does. No
 * Starkeep identity holds the grant, and no app can sign in through it.
 */
import {
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  CognitoIdentityProviderClient,
  type AdminInitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { regionFromUserPoolId } from "@starkeep/admin-installer";
import type { TestStackConfig } from "./run-state.js";

export interface PoolTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** The account still holds a temporary password, and no new one was given. */
export class NewPasswordRequired extends Error {
  constructor(email: string) {
    super(`${email} must choose a new password`);
  }
}

/**
 * Sign `email` in at `clientId` with a password. A first sign-in on a
 * temporary password throws {@link NewPasswordRequired} unless `newPassword`
 * is given, in which case the challenge is answered with it.
 */
export async function passwordSignIn(
  config: Pick<TestStackConfig, "userPoolId">,
  clientId: string,
  account: { email: string; password: string; newPassword?: string },
): Promise<PoolTokens> {
  const cognito = new CognitoIdentityProviderClient({
    region: regionFromUserPoolId(config.userPoolId),
  });
  let res: AdminInitiateAuthCommandOutput = await cognito.send(
    new AdminInitiateAuthCommand({
      UserPoolId: config.userPoolId,
      ClientId: clientId,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: account.email, PASSWORD: account.password },
    }),
  );
  if (res.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    if (!account.newPassword) throw new NewPasswordRequired(account.email);
    res = await cognito.send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: config.userPoolId,
        ClientId: clientId,
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: res.Session,
        ChallengeResponses: { USERNAME: account.email, NEW_PASSWORD: account.newPassword },
      }),
    );
  }
  const result = res.AuthenticationResult;
  if (!result?.AccessToken || !result.IdToken || !result.RefreshToken) {
    throw new Error(
      `sign-in for ${account.email} returned no session` +
        (res.ChallengeName ? ` (challenge ${res.ChallengeName})` : ""),
    );
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}
