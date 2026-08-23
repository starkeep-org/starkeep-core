/**
 * The three Cognito operations a sign-in flow needs, as plain `fetch` calls.
 *
 * `InitiateAuth` and `RespondToAuthChallenge` are unauthenticated Cognito IDP
 * operations: they carry no SigV4 signature, so there is nothing the AWS SDK
 * does for them that a JSON POST does not. Doing it by hand keeps
 * `@aws-sdk/client-cognito-identity-provider` — a large dependency — out of
 * this package and out of both apps that would otherwise pull it in to render
 * a login form.
 */

export interface PoolConfig {
  region: string;
  userPoolClientId: string;
  userPoolId: string;
}

export interface Tokens {
  idToken: string;
  refreshToken: string;
  accessToken: string;
  /** Seconds until `idToken`/`accessToken` expire, as Cognito reports them. */
  expiresIn: number;
}

export type InitiateResult =
  | { tokens: Tokens }
  | { challenge: "NEW_PASSWORD_REQUIRED"; session: string };

interface AuthenticationResult {
  AccessToken?: string;
  IdToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
}

interface CognitoResponse {
  AuthenticationResult?: AuthenticationResult;
  ChallengeName?: string;
  Session?: string;
  message?: string;
  __type?: string;
}

export class CognitoError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

async function callCognito(
  cfg: Pick<PoolConfig, "region">,
  operation: string,
  body: unknown,
): Promise<CognitoResponse> {
  const res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: CognitoResponse = {};
  try {
    parsed = text ? (JSON.parse(text) as CognitoResponse) : {};
  } catch {
    // Fall through to the error path below with an empty body — a
    // non-JSON response from Cognito is a failure however it is shaped.
  }

  if (!res.ok) {
    // Cognito reports the error class in `__type`, sometimes prefixed with a
    // namespace ("com.amazonaws.cognito...#NotAuthorizedException").
    const code = parsed.__type?.split("#").pop();
    throw new CognitoError(
      parsed.message || `Cognito ${operation} failed with ${res.status}`,
      code,
      res.status,
    );
  }
  return parsed;
}

function makeTokens(result: AuthenticationResult | undefined): Tokens {
  if (!result?.AccessToken || !result.IdToken || !result.RefreshToken) {
    throw new CognitoError("Incomplete auth result from Cognito", undefined, 502);
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}

export async function initiateAuth(
  cfg: PoolConfig,
  email: string,
  password: string,
): Promise<InitiateResult> {
  const res = await callCognito(cfg, "InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: cfg.userPoolClientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });

  if (res.AuthenticationResult) return { tokens: makeTokens(res.AuthenticationResult) };

  // A first sign-in against an admin-created user always lands here. Every
  // other challenge is one this deployment does not configure, so treating it
  // as an error is honest rather than lossy.
  if (res.ChallengeName === "NEW_PASSWORD_REQUIRED" && res.Session) {
    return { challenge: "NEW_PASSWORD_REQUIRED", session: res.Session };
  }
  throw new CognitoError(
    `Unsupported Cognito challenge: ${res.ChallengeName ?? "none"}`,
    res.ChallengeName,
    502,
  );
}

export async function respondNewPassword(
  cfg: PoolConfig,
  session: string,
  email: string,
  newPassword: string,
): Promise<Tokens> {
  const res = await callCognito(cfg, "RespondToAuthChallenge", {
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    ClientId: cfg.userPoolClientId,
    Session: session,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
  });
  return makeTokens(res.AuthenticationResult);
}

/**
 * Exchange a refresh token for a fresh id/access token pair. Cognito does not
 * return the refresh token again, hence the `Omit` — the caller already holds
 * it and keeps holding the same one.
 */
export async function refreshTokens(
  cfg: PoolConfig,
  refreshToken: string,
): Promise<Omit<Tokens, "refreshToken">> {
  const res = await callCognito(cfg, "InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: cfg.userPoolClientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
  const result = res.AuthenticationResult;
  if (!result?.AccessToken || !result.IdToken) {
    throw new CognitoError("Token refresh failed — no result returned", undefined, 401);
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}
