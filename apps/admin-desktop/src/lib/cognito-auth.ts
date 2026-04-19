/**
 * Cognito authentication client for admin-desktop.
 *
 * Uses the USER_PASSWORD_AUTH flow with Cognito's built-in email delivery.
 * No third-party libraries (Amplify, etc.) — just the raw AWS SDK clients.
 *
 * Flow for first-time sign-in:
 *   1. User creates their Cognito account via the AWS console (AdminCreateUser).
 *   2. Cognito sends a temporary password to their email.
 *   3. initiateAuth(clientId, email, tempPassword) → challengeName="NEW_PASSWORD_REQUIRED"
 *   4. respondNewPasswordChallenge(clientId, session, newPassword) → Tokens
 *   5. Store tokens; use idToken for Identity Pool credential exchange.
 *
 * Subsequent sign-ins: initiateAuth returns Tokens directly.
 * Session refresh: refreshTokens(clientId, refreshToken) → Tokens.
 */

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
  /** Set when authentication is complete. */
  tokens?: AuthTokens;
  /** Set when a challenge must be answered before tokens are issued. */
  challengeName?: string;
  /** Opaque session token — pass back to respondNewPasswordChallenge. */
  session?: string;
}

export interface STSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string; // ISO-8601
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

/**
 * Start the USER_PASSWORD_AUTH flow.
 * Returns tokens on success, or a challenge (typically NEW_PASSWORD_REQUIRED
 * for the first sign-in with a Cognito-issued temporary password).
 */
export async function initiateAuth(
  config: Pick<CognitoConfig, "region" | "userPoolClientId">,
  email: string,
  password: string
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
    })
  );

  if (response.AuthenticationResult) {
    return { tokens: makeTokens(response.AuthenticationResult) };
  }

  // Challenge required (e.g. NEW_PASSWORD_REQUIRED on first sign-in)
  return {
    challengeName: response.ChallengeName,
    session: response.Session,
  };
}

/**
 * Respond to the NEW_PASSWORD_REQUIRED challenge issued on first sign-in.
 * Returns tokens on success.
 */
export async function respondNewPasswordChallenge(
  config: Pick<CognitoConfig, "region" | "userPoolClientId">,
  session: string,
  email: string,
  newPassword: string
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
    })
  );

  if (!response.AuthenticationResult) {
    throw new Error(
      "Unexpected response to NEW_PASSWORD_REQUIRED challenge — no tokens returned"
    );
  }
  return makeTokens(response.AuthenticationResult);
}

/**
 * Refresh the user's tokens using a stored refresh token.
 */
export async function refreshTokens(
  config: Pick<CognitoConfig, "region" | "userPoolClientId">,
  refreshToken: string
): Promise<AuthTokens> {
  const client = new CognitoIdentityProviderClient({ region: config.region });
  const response = await client.send(
    new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: config.userPoolClientId,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    })
  );

  if (!response.AuthenticationResult) {
    throw new Error("Token refresh failed — no result returned");
  }

  // REFRESH_TOKEN_AUTH does not return a new refresh token; keep the old one.
  return {
    accessToken: response.AuthenticationResult.AccessToken!,
    idToken: response.AuthenticationResult.IdToken!,
    refreshToken, // unchanged
    expiresIn: response.AuthenticationResult.ExpiresIn ?? 3600,
  };
}

/**
 * Exchange a Cognito ID token for short-lived AWS STS credentials via the
 * Cognito Identity Pool.
 *
 * The resulting credentials allow admin-desktop to call AWS APIs directly
 * (e.g. run `sst deploy`, access S3, DSQL) using the permissions granted to
 * the authenticated IAM role defined in the bootstrap CloudFormation stack.
 *
 * IMPORTANT: The Logins map key must be the full Cognito issuer URL
 * (cognito-idp.{region}.amazonaws.com/{userPoolId}), NOT just the pool ID.
 * The value must be the ID token (not the access token).
 */
export async function getIdentityPoolCredentials(
  config: CognitoConfig,
  idToken: string
): Promise<STSCredentials> {
  const client = new CognitoIdentityClient({ region: config.region });

  const loginKey = `cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
  const logins = { [loginKey]: idToken };

  // Step 1: Get the Cognito Identity ID for this user.
  const idResponse = await client.send(
    new GetIdCommand({
      IdentityPoolId: config.identityPoolId,
      Logins: logins,
    })
  );

  if (!idResponse.IdentityId) {
    throw new Error("Failed to get Cognito Identity ID");
  }

  // Step 2: Exchange the Identity ID for STS credentials.
  const credsResponse = await client.send(
    new GetCredentialsForIdentityCommand({
      IdentityId: idResponse.IdentityId,
      Logins: logins,
    })
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

/**
 * Start a background timer that refreshes STS credentials every 45 minutes
 * (STS credentials expire after 1 hour; 45 min gives 15 min of overlap).
 *
 * The timer uses the stored Cognito refresh token to obtain a new ID token,
 * then exchanges it for fresh STS credentials via the Identity Pool.
 *
 * Returns a cleanup function — call it on app teardown.
 */
export function startCredentialRefreshTimer(
  config: CognitoConfig,
  getRefreshToken: () => string | null,
  onNewCredentials: (creds: STSCredentials) => void,
  onError?: (err: Error) => void
): () => void {
  const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes

  const refresh = async () => {
    const refreshToken = getRefreshToken();
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
