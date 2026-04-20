import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
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

export interface STSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
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
