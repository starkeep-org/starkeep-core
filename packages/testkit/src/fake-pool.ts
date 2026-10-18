/**
 * A fake Cognito user pool for the device client, served by the fake cloud.
 *
 * Speaks the four calls a device makes — `InitiateAuth` with
 * `USER_PASSWORD_AUTH` and `REFRESH_TOKEN_AUTH`, `RespondToAuthChallenge` for
 * `NEW_PASSWORD_REQUIRED`, and `RevokeToken` — in Cognito's JSON wire format, so
 * the shared Cognito client in protocol-primitives talks to it unchanged. A
 * local data server reaches it through `STARKEEP_COGNITO_ENDPOINT`.
 *
 * ID tokens are HMAC-signed with a per-pool secret rather than RS256, because
 * nothing outside this process verifies them: the fake cloud checks the ones it
 * issued, and the devices read their claims without verifying.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const FAKE_POOL_REGION = "us-east-1";
export const FAKE_POOL_ID = "us-east-1_FakePool1";
export const FAKE_DEVICE_CLIENT_ID = "fakedeviceclient0000000001";

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
  addUser(email: string, password: string, options?: { sub?: string; temporary?: boolean; groups?: string[] }): void;
  /** End every sign-in of a user, as `AdminUserGlobalSignOut` does. */
  signOutEverywhere(email: string): void;
  /** Refresh tokens a device revoked with `RevokeToken`. */
  readonly revoked: ReadonlySet<string>;
  /** How many sign-ins succeeded, by email. */
  signIns(email: string): number;
  /** The claims of a valid, unexpired ID token this pool issued, or null. */
  verify(idToken: string): { sub: string; email: string; groups: string[] } | null;
  /** Answer one Cognito API call. */
  handle(target: string, body: Record<string, unknown>): { status: number; body: unknown };
}

export function createFakePool(): FakePool {
  const secret = randomBytes(32);
  const users = new Map<string, FakeUser>();
  const refreshTokens = new Map<string, IssuedRefresh>();
  const revoked = new Set<string>();
  const signInCounts = new Map<string, number>();
  const sessions = new Map<string, string>();

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

    signIns: (email) => signInCounts.get(email) ?? 0,

    verify(idToken) {
      const [header, payload, signature] = idToken.split(".");
      if (!header || !payload || !signature) return null;
      const expected = Buffer.from(sign(`${header}.${payload}`));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected as unknown as Uint8Array, actual as unknown as Uint8Array)) {
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
      if (body["ClientId"] !== FAKE_DEVICE_CLIENT_ID) {
        return { status: 400, body: { __type: "ResourceNotFoundException", message: "User pool client does not exist." } };
      }
      if (target === "InitiateAuth" && body["AuthFlow"] === "USER_PASSWORD_AUTH") {
        const params = body["AuthParameters"] as { USERNAME?: string; PASSWORD?: string };
        const email = params.USERNAME ?? "";
        const user = users.get(email);
        if (!user || user.password !== params.PASSWORD) return notAuthorized("Incorrect username or password.");
        if (user.temporary) {
          const session = `session-${randomUUID()}`;
          sessions.set(session, email);
          return { status: 200, body: { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: session } };
        }
        signInCounts.set(email, (signInCounts.get(email) ?? 0) + 1);
        return { status: 200, body: issue(email, user) };
      }
      if (target === "RespondToAuthChallenge" && body["ChallengeName"] === "NEW_PASSWORD_REQUIRED") {
        const session = String(body["Session"] ?? "");
        const email = sessions.get(session);
        const responses = body["ChallengeResponses"] as { USERNAME?: string; NEW_PASSWORD?: string };
        const user = email ? users.get(email) : undefined;
        if (!email || !user || responses.USERNAME !== email) return notAuthorized("Invalid session for the user.");
        if (!responses.NEW_PASSWORD || responses.NEW_PASSWORD.length < 8) {
          return { status: 400, body: { __type: "InvalidPasswordException", message: "Password did not conform with policy: too short" } };
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
        if (!issued || !user || revoked.has(token)) return notAuthorized("Refresh Token has been revoked");
        return { status: 200, body: issue(issued.email, user, token) };
      }
      if (target === "RevokeToken") {
        revoked.add(String(body["Token"] ?? ""));
        return { status: 200, body: {} };
      }
      return { status: 400, body: { __type: "InvalidParameterException", message: `fake pool cannot answer ${target}` } };
    },
  };
}
