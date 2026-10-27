/**
 * The one Cognito operation a cloud app session needs, as a plain `fetch` call:
 * exchanging the session's refresh token for a fresh ID token.
 *
 * Sign-in itself happens on the managed login page, which the platform's
 * `/auth/start` route sends the browser to. App code never receives a
 * password, so nothing here starts a password flow.
 *
 * `InitiateAuth` with `REFRESH_TOKEN_AUTH` is an unauthenticated Cognito IDP
 * operation: it carries no SigV4 signature, so there is nothing the AWS SDK
 * does for it that a JSON POST does not. Doing it by hand keeps
 * `@aws-sdk/client-cognito-identity-provider` — a large dependency — out of
 * this package and out of every app that uses it.
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

interface AuthenticationResult {
  AccessToken?: string;
  IdToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
}

interface CognitoResponse {
  AuthenticationResult?: AuthenticationResult;
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
