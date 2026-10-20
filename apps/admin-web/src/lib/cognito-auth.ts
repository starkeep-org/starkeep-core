import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type AuthenticationResultType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from "@aws-sdk/client-cognito-identity";

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

export function extractEmailFromIdToken(idToken: string): string | null {
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1]));
    return (payload.email as string) ?? null;
  } catch {
    return null;
  }
}

/** The group whose members administer the deployment. */
export const ADMINS_GROUP = "starkeep-admins";

/** The refusal an account outside the admin group gets from admin-web. */
export const NOT_AN_ADMIN =
  "This account has no admin rights on this cloud. Ask an admin to make you one.";

/** The `cognito:groups` claim of an ID token, or none. The token came straight from Cognito, so it is read, not verified. */
export function groupsOfIdToken(idToken: string): string[] {
  try {
    const payload = JSON.parse(
      atob(idToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as {
      "cognito:groups"?: unknown;
    };
    const groups = payload["cognito:groups"];
    return Array.isArray(groups) ? groups.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
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
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    }),
  );

  if (response.AuthenticationResult) {
    return { tokens: makeTokens(response.AuthenticationResult) };
  }

  return {
    challengeName: response.ChallengeName,
    session: response.Session,
  };
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
      ChallengeResponses: {
        USERNAME: email,
        NEW_PASSWORD: newPassword,
      },
    }),
  );

  if (!response.AuthenticationResult) {
    throw new Error("Unexpected response to NEW_PASSWORD_REQUIRED challenge — no tokens returned");
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
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
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

export async function getIdentityPoolCredentials(
  config: CognitoConfig,
  idToken: string,
): Promise<STSCredentials> {
  // The identity pool hands credentials to admins only and denies everyone
  // else with an error that names no reason. Saying so here, from the token,
  // is what lets the sign-in say why.
  if (!groupsOfIdToken(idToken).includes(ADMINS_GROUP)) throw new Error(NOT_AN_ADMIN);
  const client = new CognitoIdentityClient({ region: config.region });

  const loginKey = `cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
  const logins = { [loginKey]: idToken };

  const idResponse = await client.send(
    new GetIdCommand({
      IdentityPoolId: config.identityPoolId,
      Logins: logins,
    }),
  );

  if (!idResponse.IdentityId) {
    throw new Error("Failed to get Cognito Identity ID");
  }

  const credsResponse = await client.send(
    new GetCredentialsForIdentityCommand({
      IdentityId: idResponse.IdentityId,
      Logins: logins,
    }),
  );

  const c = credsResponse.Credentials;
  if (!c?.AccessKeyId || !c.SecretKey || !c.SessionToken || !c.Expiration) {
    throw new Error("Incomplete credentials returned from Identity Pool");
  }

  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration.toISOString(),
  };
}

export function startCredentialRefreshTimer(
  config: CognitoConfig,
  getRefreshToken: () => string | null | Promise<string | null>,
  onNewCredentials: (creds: STSCredentials) => void,
  onError?: (err: Error) => void,
): () => void {
  const REFRESH_INTERVAL_MS = 45 * 60 * 1000;

  const refresh = async () => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) return;
    try {
      const tokens = await refreshTokens(config, refreshToken);
      const creds = await getIdentityPoolCredentials(config, tokens.idToken);
      onNewCredentials(creds);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const handle = setInterval(refresh, REFRESH_INTERVAL_MS);
  return () => clearInterval(handle);
}
