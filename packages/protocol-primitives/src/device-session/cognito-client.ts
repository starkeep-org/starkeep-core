/**
 * A device's sign-in, over `fetch` rather than the AWS SDK.
 *
 * One implementation for every host that signs a device in: the local data
 * server and the phone. Every call a device makes (`InitiateAuth`,
 * `RespondToAuthChallenge`, refresh, `RevokeToken`) is an **unsigned** JSON
 * post to the pool's regional endpoint, so the SDK would be carried entirely
 * for its request builder — and on a React Native bundle, with its Node-shaped
 * dependencies and the polyfill hunt that follows.
 *
 * The cost of doing it by hand is that the wire format lives here: the target
 * header, the error envelope, the auth-parameter names. That is a small,
 * stable, documented surface, fully exercisable against a fake `fetch`.
 *
 * The client signs in through the pool's **device** app client. The identity
 * pool does not trust that client, so a device token is no route to an AWS
 * role; the cloud data server accepts it alone on its device-token branch.
 */

export interface AuthTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/**
 * Either tokens, or a challenge that must be answered first.
 *
 * `NEW_PASSWORD_REQUIRED` is the expected first-sign-in state for an account
 * an admin created, so it is modelled rather than treated as an error — a form
 * that says "incorrect password" to a password that is merely temporary
 * leaves the person nowhere to go.
 */
export type SignInResult =
  | { readonly kind: "tokens"; readonly tokens: AuthTokens }
  | { readonly kind: "new-password-required"; readonly session: string };

export interface CognitoClientOptions {
  readonly region: string;
  readonly userPoolClientId: string;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The pool's API endpoint. Defaults to the region's public endpoint; a test
   * points it at a fake pool.
   */
  readonly endpoint?: string;
}

/**
 * Cognito's error envelope: `{"__type": "NotAuthorizedException", "message": ...}`.
 *
 * `status` is carried because callers need to distinguish *the pool rejected
 * this credential* from *the pool did not answer* — a 4xx means a stored
 * refresh token is dead and should be discarded, while a 5xx means Cognito is
 * having a bad day and the token is very likely still good.
 *
 * Zero for errors raised here rather than by Cognito, which is deliberately not
 * in the 4xx band: a response this client failed to make sense of is not
 * evidence that the credential is bad.
 */
export class CognitoError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 0,
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

interface AuthenticationResult {
  AccessToken?: string;
  IdToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
}

interface AuthResponse {
  AuthenticationResult?: AuthenticationResult;
  ChallengeName?: string;
  Session?: string;
}

export interface CognitoClient {
  signIn(email: string, password: string): Promise<SignInResult>;
  /** Answer a `NEW_PASSWORD_REQUIRED` challenge. */
  setNewPassword(email: string, session: string, newPassword: string): Promise<AuthTokens>;
  /**
   * Exchange a stored refresh token for a live session.
   *
   * Cognito does not return the refresh token again, so the caller's stored one
   * remains authoritative — it is echoed back here so callers never have to know
   * that.
   */
  refresh(refreshToken: string): Promise<AuthTokens>;
  /**
   * End this sign-in at the pool: the refresh token, and every ID and access
   * token issued from it, stop working. The user's other devices are untouched.
   *
   * Needs nothing but the token itself, because the device client is public
   * (no secret) and has token revocation enabled.
   */
  revoke(refreshToken: string): Promise<void>;
}

export function createCognitoClient(options: CognitoClientOptions): CognitoClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? `https://cognito-idp.${options.region}.amazonaws.com/`;

  async function call(target: string, body: unknown): Promise<AuthResponse> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // A proxy's HTML error page, say. Not Cognito's answer about anything.
      throw new CognitoError("UnreadableResponse", `Cognito answered ${response.status} with no JSON`);
    }

    if (!response.ok) {
      // `__type` arrives either bare or ARN-qualified depending on the error;
      // the tail is the part anyone matches on.
      const type = String(parsed["__type"] ?? "UnknownError");
      const code = type.slice(type.lastIndexOf("#") + 1);
      const message = String(parsed["message"] ?? parsed["Message"] ?? response.statusText);
      throw new CognitoError(code, message, response.status);
    }

    return parsed as AuthResponse;
  }

  function tokensFrom(result: AuthenticationResult | undefined, refreshToken?: string): AuthTokens {
    const refresh = result?.RefreshToken ?? refreshToken;
    if (!result?.AccessToken || !result.IdToken || !refresh) {
      throw new CognitoError("IncompleteAuthResult", "Cognito returned an incomplete session");
    }
    return {
      accessToken: result.AccessToken,
      idToken: result.IdToken,
      refreshToken: refresh,
      expiresIn: result.ExpiresIn ?? 3600,
    };
  }

  return {
    async signIn(email, password) {
      const response = await call("InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: options.userPoolClientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      });

      if (response.AuthenticationResult) {
        return { kind: "tokens", tokens: tokensFrom(response.AuthenticationResult) };
      }
      if (response.ChallengeName === "NEW_PASSWORD_REQUIRED" && response.Session) {
        return { kind: "new-password-required", session: response.Session };
      }
      // MFA and the rest are real Cognito states a device cannot answer. Naming
      // the challenge beats "sign-in failed", which would send someone looking
      // at their password.
      throw new CognitoError(
        "UnsupportedChallenge",
        `Sign-in needs a challenge this device cannot answer: ${response.ChallengeName ?? "unknown"}`,
      );
    },

    async setNewPassword(email, session, newPassword) {
      const response = await call("RespondToAuthChallenge", {
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: options.userPoolClientId,
        Session: session,
        ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
      });
      return tokensFrom(response.AuthenticationResult);
    },

    async refresh(refreshToken) {
      const response = await call("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: options.userPoolClientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });
      return tokensFrom(response.AuthenticationResult, refreshToken);
    },

    async revoke(refreshToken) {
      await call("RevokeToken", { Token: refreshToken, ClientId: options.userPoolClientId });
    },
  };
}

/** The claims a device reads from its own ID token. */
export interface IdTokenClaims {
  readonly sub: string | null;
  readonly email: string | null;
  /** Expiry, in epoch seconds. */
  readonly exp: number | null;
  /** The account's Cognito groups (`cognito:groups`), empty when it has none. */
  readonly groups: readonly string[];
}

/**
 * The group whose members have a data library that syncs. The cloud data
 * server refuses a device token without it; a device checks it at sign-in too,
 * so an account that can never sync does not bind the device's library.
 */
export const DATA_GROUP = "starkeep-users";

/**
 * An ID token's claims, decoded and **not verified**.
 *
 * A device reads its own token for display (the email), for scheduling (when
 * to refresh) and for binding its library (the `sub`). None of that needs the
 * signature checked: the token came straight from the pool over TLS, and the
 * cloud checks the signature on every request. A device re-checking it would be
 * proving something to itself.
 *
 * Base64url is decoded by hand because `atob` is not something to bet a sign-in
 * on across Hermes versions, and the alternative is a dependency.
 */
export function idTokenClaims(idToken: string): IdTokenClaims {
  const none: IdTokenClaims = { sub: null, email: null, exp: null, groups: [] };
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return none;
    const claims = JSON.parse(decodeBase64Url(payload)) as Record<string, unknown>;
    return {
      sub: typeof claims["sub"] === "string" && claims["sub"] ? claims["sub"] : null,
      email: typeof claims["email"] === "string" ? claims["email"] : null,
      exp: typeof claims["exp"] === "number" ? claims["exp"] : null,
      groups: Array.isArray(claims["cognito:groups"])
        ? claims["cognito:groups"].filter((g): g is string => typeof g === "string")
        : [],
    };
  } catch {
    return none;
  }
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    if (char === "=") break;
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) throw new Error("not base64url");
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
