import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type AuthenticationResultType,
} from "@aws-sdk/client-cognito-identity-provider";

export interface CognitoConfig {
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  region: string;
}

export interface AuthTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthResult {
  tokens?: AuthTokens;
  challengeName?: string;
  session?: string;
}

export interface STSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

function makeTokens(result: AuthenticationResultType): AuthTokens {
  if (!result.AccessToken || !result.IdToken || !result.RefreshToken) {
    throw new Error("Incomplete auth result from Cognito");
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}

export async function initiateAuth(
  config: Pick<CognitoConfig, "region" | "userPoolClientId">,
  email: string,
  password: string,
): Promise<AuthResult> {
  const client = new CognitoIdentityProviderClient({ region: config.region });
  const response = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: config.userPoolClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );
  if (response.AuthenticationResult) {
    return { tokens: makeTokens(response.AuthenticationResult) };
  }
  return { challengeName: response.ChallengeName, session: response.Session };
}

export async function respondNewPasswordChallenge(
  config: Pick<CognitoConfig, "region" | "userPoolClientId">,
  session: string,
  email: string,
  newPassword: string,
): Promise<AuthTokens> {
  const client = new CognitoIdentityProviderClient({ region: config.region });
  const response = await client.send(
    new RespondToAuthChallengeCommand({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ClientId: config.userPoolClientId,
      Session: session,
      ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
    }),
  );
  if (!response.AuthenticationResult) {
    throw new Error("Unexpected response to NEW_PASSWORD_REQUIRED challenge");
  }
  return makeTokens(response.AuthenticationResult);
}

export async function refreshTokens(
  config: Pick<CognitoConfig, "region" | "userPoolClientId">,
  refreshToken: string,
): Promise<AuthTokens> {
  const client = new CognitoIdentityProviderClient({ region: config.region });
  const response = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: config.userPoolClientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  );

  if (!response.AuthenticationResult) {
    throw new Error("Token refresh failed — no result returned");
  }

  return {
    accessToken: response.AuthenticationResult.AccessToken!,
    idToken: response.AuthenticationResult.IdToken!,
    refreshToken,
    expiresIn: response.AuthenticationResult.ExpiresIn ?? 3600,
  };
}
