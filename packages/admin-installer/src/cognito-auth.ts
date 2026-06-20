/**
 * Cognito admin sign-in: USER_PASSWORD_AUTH against the bootstrap user pool,
 * then Identity Pool federation to temporary AWS credentials.
 *
 * This is the auth chain every install CLI walks before it can assume the
 * Manager role. Shared here so the CLIs and the Tier-3 AWS test runner
 * exercise the identical code path.
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from "@aws-sdk/client-cognito-identity";

export interface CognitoUserPoolRef {
  userPoolId: string;
  userPoolClientId: string;
}

export interface CognitoIdentityPoolRef extends CognitoUserPoolRef {
  identityPoolId: string;
}

/**
 * Region is not stored in config.json — AWS encodes it into the user pool ID
 * (e.g. `us-east-2_Xxxxx`), so it is derived from there everywhere.
 */
export function regionFromUserPoolId(userPoolId: string): string {
  const parts = userPoolId.split("_");
  if (parts.length < 2 || !parts[0]) {
    throw new Error(
      `userPoolId "${userPoolId}" is not in the expected format <region>_<id>. ` +
        `Region is derived from userPoolId, so this prevents the installer from running.`,
    );
  }
  return parts[0];
}

/** The token pair a successful Cognito sign-in yields. */
export interface CognitoTokens {
  idToken: string;
  /**
   * The long-lived refresh token. Required by the local-data-server's
   * `/auth/tokens` handoff, which uses it to seed the in-daemon credential
   * refresh timer — a plain idToken alone can't keep cloud credentials live.
   */
  refreshToken: string;
}

/**
 * Authenticate an admin user and return the Cognito ID + refresh tokens.
 *
 * A NEW_PASSWORD_REQUIRED challenge (first login of a console- or
 * AdminCreateUser-created account with a temporary password) is resolved by
 * calling `promptNewPassword`; without the callback the challenge is an error.
 */
export async function cognitoPasswordAuthTokens(
  pool: CognitoUserPoolRef,
  email: string,
  password: string,
  promptNewPassword?: () => Promise<string>,
): Promise<CognitoTokens> {
  const region = regionFromUserPoolId(pool.userPoolId);
  const client = new CognitoIdentityProviderClient({ region });

  const initResponse = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: pool.userPoolClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );

  if (initResponse.AuthenticationResult?.IdToken) {
    return tokensFromAuthResult(initResponse.AuthenticationResult);
  }

  if (initResponse.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    if (!promptNewPassword) {
      throw new Error(
        "Account requires a new password (first login) and no promptNewPassword handler was provided",
      );
    }
    const newPassword = await promptNewPassword();

    const challengeResponse = await client.send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: pool.userPoolClientId,
        Session: initResponse.Session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
      }),
    );

    if (!challengeResponse.AuthenticationResult?.IdToken) {
      throw new Error("No ID token returned after password challenge");
    }
    return tokensFromAuthResult(challengeResponse.AuthenticationResult);
  }

  throw new Error(`Unexpected Cognito challenge: ${initResponse.ChallengeName}`);
}

function tokensFromAuthResult(result: {
  IdToken?: string;
  RefreshToken?: string;
}): CognitoTokens {
  if (!result.IdToken) throw new Error("No ID token returned from Cognito");
  if (!result.RefreshToken) throw new Error("No refresh token returned from Cognito");
  return { idToken: result.IdToken, refreshToken: result.RefreshToken };
}

/**
 * Authenticate an admin user and return just the Cognito ID token — the leg
 * every install CLI walks before assuming the Manager role. Callers that also
 * need the refresh token (the LDS sign-in handoff) use
 * {@link cognitoPasswordAuthTokens}.
 */
export async function cognitoPasswordAuth(
  pool: CognitoUserPoolRef,
  email: string,
  password: string,
  promptNewPassword?: () => Promise<string>,
): Promise<string> {
  return (await cognitoPasswordAuthTokens(pool, email, password, promptNewPassword)).idToken;
}

export interface IdentityPoolCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** Exchange a user-pool ID token for temporary AWS credentials (admin-app role). */
export async function getIdentityPoolCredentials(
  pool: CognitoIdentityPoolRef,
  idToken: string,
): Promise<IdentityPoolCredentials> {
  const region = regionFromUserPoolId(pool.userPoolId);
  const client = new CognitoIdentityClient({ region });
  const loginKey = `cognito-idp.${region}.amazonaws.com/${pool.userPoolId}`;
  const logins = { [loginKey]: idToken };

  const idResponse = await client.send(
    new GetIdCommand({ IdentityPoolId: pool.identityPoolId, Logins: logins }),
  );
  if (!idResponse.IdentityId) throw new Error("Failed to get Cognito Identity ID");

  const credsResponse = await client.send(
    new GetCredentialsForIdentityCommand({ IdentityId: idResponse.IdentityId, Logins: logins }),
  );

  const c = credsResponse.Credentials;
  if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken) {
    throw new Error("Incomplete credentials from Identity Pool");
  }

  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretKey,
    sessionToken: c.SessionToken,
  };
}
