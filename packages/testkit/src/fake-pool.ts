/**
 * A fake Cognito user pool for the device client, served by the fake cloud.
 *
 * Speaks the calls the real device client allows, in Cognito's JSON wire
 * format, so the shared Cognito client in protocol-primitives talks to it
 * unchanged: `InitiateAuth` with `REFRESH_TOKEN_AUTH`, `RevokeToken`, and the
 * harness's password sign-in, `AdminInitiateAuth` with
 * `ADMIN_USER_PASSWORD_AUTH` and `AdminRespondToAuthChallenge` for
 * `NEW_PASSWORD_REQUIRED`. `USER_PASSWORD_AUTH` is refused, as the client
 * refuses it. A person's sign-in on the managed login page is
 * {@link FakePool.issueCode} followed by the token endpoint,
 * {@link FakePool.redeemCode}. A local data server reaches the pool through
 * `STARKEEP_COGNITO_ENDPOINT` and the token endpoint through
 * `STARKEEP_COGNITO_TOKEN_ENDPOINT`.
 *
 * ID tokens are HMAC-signed with a per-pool secret rather than RS256, because
 * nothing outside this process verifies them: the fake cloud checks the ones it
 * issued, and the devices read their claims without verifying.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const FAKE_POOL_REGION = "us-east-1";
export const FAKE_POOL_ID = "us-east-1_FakePool1";
export const FAKE_DEVICE_CLIENT_ID = "fakedeviceclient0000000001";
/** The managed login page's host name the fake cloud names in `/auth/config`. */
export const FAKE_COGNITO_DOMAIN = "fake-pool.auth.us-east-1.amazoncognito.com";

/** Fifteen minutes, as the real device client issues. */
const ID_TOKEN_LIFETIME_SECONDS = 15 * 60;

interface FakeUser {
  sub: string;
  password: string;
  /** Answer the next sign-in with NEW_PASSWORD_REQUIRED, as an admin-created account does. */
  temporary: boolean;
  groups: string[];
}

interface IssuedRefresh {
  email: string;
  originJti: string;
}

export interface FakePool {
  addUser(
    email: string,
    password: string,
    options?: { sub?: string; temporary?: boolean; groups?: string[] },
  ): void;
  /** End every sign-in of a user, as `AdminUserGlobalSignOut` does. */
  signOutEverywhere(email: string): void;
  /** Refresh tokens a device revoked with `RevokeToken`. */
  readonly revoked: ReadonlySet<string>;
  /**
   * While false, every call answers 503, which a device reads as a pool out of
   * reach rather than a refusal. True to begin with.
   */
  reachable: boolean;
  /** How many sign-ins succeeded, by email. */
  signIns(email: string): number;
  /** The claims of a valid, unexpired ID token this pool issued, or null. */
  verify(idToken: string): { sub: string; email: string; groups: string[] } | null;
  /** Answer one Cognito API call. */
  handle(target: string, body: Record<string, unknown>): { status: number; body: unknown };
  /**
   * What the managed login page does once a person signs in: a one-time code
   * for the callback, bound to the PKCE challenge and the callback URL.
   * Throws for an unknown user.
   */
  issueCode(email: string, options: { codeChallenge: string; redirectUri: string }): string;
  /** Answer the token endpoint's `authorization_code` grant. */
  redeemCode(form: URLSearchParams): { status: number; body: unknown };
}

export function createFakePool(): FakePool {
  const secret = randomBytes(32);
  const users = new Map<string, FakeUser>();
  const refreshTokens = new Map<string, IssuedRefresh>();
  const revoked = new Set<string>();
  const signInCounts = new Map<string, number>();
  const sessions = new Map<string, string>();
  const codes = new Map<string, { email: string; codeChallenge: string; redirectUri: string }>();

  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = (data: string) => createHmac("sha256", secret).update(data).digest("base64url");

  function idTokenFor(email: string, user: FakeUser, originJti: string): string {
    const header = b64url({ alg: "HS256", kid: "fake" });
    const payload = b64url({
      iss: `https://cognito-idp.${FAKE_POOL_REGION}.amazonaws.com/${FAKE_POOL_ID}`,
      aud: FAKE_DEVICE_CLIENT_ID,
      token_use: "id",
      sub: user.sub,
      email,
      "cognito:groups": user.groups,
      origin_jti: originJti,
      exp: Math.floor(Date.now() / 1000) + ID_TOKEN_LIFETIME_SECONDS,
    });
    return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
  }

  function issue(email: string, user: FakeUser, refreshToken?: string) {
    const refresh = refreshToken ?? `refresh-${randomUUID()}`;
    const issued = refreshTokens.get(refresh) ?? { email, originJti: randomUUID() };
    refreshTokens.set(refresh, issued);
    return {
      AuthenticationResult: {
        AccessToken: `access-${randomUUID()}`,
        IdToken: idTokenFor(email, user, issued.originJti),
        ...(refreshToken ? {} : { RefreshToken: refresh }),
        ExpiresIn: ID_TOKEN_LIFETIME_SECONDS,
      },
    };
  }

  const notAuthorized = (message: string) => ({
    status: 400,
    body: { __type: "NotAuthorizedException", message },
  });

  return {
    addUser(email, password, options = {}) {
      users.set(email, {
        sub: options.sub ?? `sub-${randomUUID()}`,
        password,
        temporary: options.temporary ?? false,
        groups: options.groups ?? ["starkeep-users"],
      });
    },

    signOutEverywhere(email) {
      for (const [token, issued] of refreshTokens) {
        if (issued.email === email) revoked.add(token);
      }
    },

    revoked,

    reachable: true,

    signIns: (email) => signInCounts.get(email) ?? 0,

    verify(idToken) {
      const [header, payload, signature] = idToken.split(".");
      if (!header || !payload || !signature) return null;
      const expected = Buffer.from(sign(`${header}.${payload}`));
      const actual = Buffer.from(signature);
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected as unknown as Uint8Array, actual as unknown as Uint8Array)
      ) {
        return null;
      }
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        sub: string;
        email: string;
        exp: number;
        aud: string;
        token_use: string;
        "cognito:groups": string[];
      };
      if (claims.aud !== FAKE_DEVICE_CLIENT_ID || claims.token_use !== "id") return null;
      if (claims.exp * 1000 <= Date.now()) return null;
      return { sub: claims.sub, email: claims.email, groups: claims["cognito:groups"] };
    },

    handle(target, body) {
      if (!this.reachable)
        return { status: 503, body: { __type: "ServiceUnavailable", message: "Out of reach" } };
      if (body["ClientId"] !== FAKE_DEVICE_CLIENT_ID) {
        return {
          status: 400,
          body: {
            __type: "ResourceNotFoundException",
            message: "User pool client does not exist.",
          },
        };
      }
      if (target === "InitiateAuth" && body["AuthFlow"] === "USER_PASSWORD_AUTH") {
        return {
          status: 400,
          body: {
            __type: "InvalidParameterException",
            message: "USER_PASSWORD_AUTH flow not enabled for this client",
          },
        };
      }
      // The harness's password sign-in, which needs AWS credentials in the
      // real pool. The fake checks the pool id instead of a signature.
      if (
        (target === "AdminInitiateAuth" || target === "AdminRespondToAuthChallenge") &&
        body["UserPoolId"] !== FAKE_POOL_ID
      ) {
        return {
          status: 400,
          body: { __type: "ResourceNotFoundException", message: "User pool does not exist." },
        };
      }
      if (target === "AdminInitiateAuth" && body["AuthFlow"] === "ADMIN_USER_PASSWORD_AUTH") {
        const params = body["AuthParameters"] as { USERNAME?: string; PASSWORD?: string };
        const email = params.USERNAME ?? "";
        const user = users.get(email);
        if (!user || user.password !== params.PASSWORD)
          return notAuthorized("Incorrect username or password.");
        if (user.temporary) {
          const session = `session-${randomUUID()}`;
          sessions.set(session, email);
          return {
            status: 200,
            body: { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: session },
          };
        }
        signInCounts.set(email, (signInCounts.get(email) ?? 0) + 1);
        return { status: 200, body: issue(email, user) };
      }
      if (
        target === "AdminRespondToAuthChallenge" &&
        body["ChallengeName"] === "NEW_PASSWORD_REQUIRED"
      ) {
        const session = String(body["Session"] ?? "");
        const email = sessions.get(session);
        const responses = body["ChallengeResponses"] as {
          USERNAME?: string;
          NEW_PASSWORD?: string;
        };
        const user = email ? users.get(email) : undefined;
        if (!email || !user || responses.USERNAME !== email)
          return notAuthorized("Invalid session for the user.");
        if (!responses.NEW_PASSWORD || responses.NEW_PASSWORD.length < 8) {
          return {
            status: 400,
            body: {
              __type: "InvalidPasswordException",
              message: "Password did not conform with policy: too short",
            },
          };
        }
        sessions.delete(session);
        user.password = responses.NEW_PASSWORD;
        user.temporary = false;
        signInCounts.set(email, (signInCounts.get(email) ?? 0) + 1);
        return { status: 200, body: issue(email, user) };
      }
      if (target === "InitiateAuth" && body["AuthFlow"] === "REFRESH_TOKEN_AUTH") {
        const token = (body["AuthParameters"] as { REFRESH_TOKEN?: string }).REFRESH_TOKEN ?? "";
        const issued = refreshTokens.get(token);
        const user = issued ? users.get(issued.email) : undefined;
        if (!issued || !user || revoked.has(token))
          return notAuthorized("Refresh Token has been revoked");
        return { status: 200, body: issue(issued.email, user, token) };
      }
      if (target === "RevokeToken") {
        revoked.add(String(body["Token"] ?? ""));
        return { status: 200, body: {} };
      }
      return {
        status: 400,
        body: { __type: "InvalidParameterException", message: `fake pool cannot answer ${target}` },
      };
    },

    issueCode(email, options) {
      const user = users.get(email);
      if (!user) throw new Error(`The fake pool has no user ${email}`);
      // The page has the person set a permanent password at a first sign-in.
      user.temporary = false;
      const code = `code-${randomUUID()}`;
      codes.set(code, { email, ...options });
      return code;
    },

    redeemCode(form) {
      if (!this.reachable) return { status: 503, body: { error: "temporarily_unavailable" } };
      const invalid = (description: string) => ({
        status: 400,
        body: { error: "invalid_grant", error_description: description },
      });
      if (form.get("grant_type") !== "authorization_code") {
        return { status: 400, body: { error: "unsupported_grant_type" } };
      }
      if (form.get("client_id") !== FAKE_DEVICE_CLIENT_ID) {
        return { status: 400, body: { error: "invalid_client" } };
      }
      const code = form.get("code") ?? "";
      const issuedCode = codes.get(code);
      // A code is good once, whatever the outcome.
      codes.delete(code);
      if (!issuedCode) return invalid("unknown or used code");
      if (form.get("redirect_uri") !== issuedCode.redirectUri) return invalid("redirect mismatch");
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (challenge !== issuedCode.codeChallenge) return invalid("PKCE check failed");
      const user = users.get(issuedCode.email);
      if (!user) return invalid("unknown user");
      signInCounts.set(issuedCode.email, (signInCounts.get(issuedCode.email) ?? 0) + 1);
      const result = issue(issuedCode.email, user).AuthenticationResult;
      return {
        status: 200,
        body: {
          id_token: result.IdToken,
          access_token: result.AccessToken,
          refresh_token: result.RefreshToken,
          expires_in: result.ExpiresIn,
          token_type: "Bearer",
        },
      };
    },
  };
}

/**
 * Sign a user in at a pool the way the e2e harness does, with
 * `ADMIN_USER_PASSWORD_AUTH`, answering a first sign-in's new-password
 * challenge with `newPassword`. Returns the refresh token, which a local data
 * server's `/auth/login` accepts as `{ refreshToken }`.
 */
export async function adminPasswordSignIn(
  cognitoEndpoint: string,
  account: { email: string; password: string; newPassword?: string },
  pool: { userPoolId: string; clientId: string } = {
    userPoolId: FAKE_POOL_ID,
    clientId: FAKE_DEVICE_CLIENT_ID,
  },
): Promise<string> {
  async function call(target: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(cognitoEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`${target} failed: ${res.status} ${JSON.stringify(parsed)}`);
    return parsed;
  }
  let answer = await call("AdminInitiateAuth", {
    UserPoolId: pool.userPoolId,
    ClientId: pool.clientId,
    AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: account.email, PASSWORD: account.password },
  });
  if (answer["ChallengeName"] === "NEW_PASSWORD_REQUIRED") {
    if (!account.newPassword) throw new Error(`${account.email} must choose a new password`);
    answer = await call("AdminRespondToAuthChallenge", {
      UserPoolId: pool.userPoolId,
      ClientId: pool.clientId,
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: answer["Session"],
      ChallengeResponses: { USERNAME: account.email, NEW_PASSWORD: account.newPassword },
    });
  }
  const refresh = (answer["AuthenticationResult"] as { RefreshToken?: string } | undefined)
    ?.RefreshToken;
  if (!refresh) throw new Error("The pool answered without a refresh token");
  return refresh;
}
