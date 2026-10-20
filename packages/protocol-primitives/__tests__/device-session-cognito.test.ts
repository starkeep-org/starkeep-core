/**
 * Sign-in, against a fake `fetch`.
 *
 * The client hand-writes Cognito's wire format instead of carrying the AWS SDK,
 * so the wire format is what these assert: the target header, the auth-parameter
 * names, the error envelope. Those are exactly the things that a device would
 * report as an unexplained "sign-in failed", with nothing to look at.
 */
import { describe, it, expect } from "vitest";
import { CognitoError, createCognitoClient, idTokenClaims } from "../src/index.js";

const emailFromIdToken = (idToken: string) => idTokenClaims(idToken).email;

interface Call {
  url: string;
  target: string;
  body: Record<string, unknown>;
}

/** A `fetch` that records what it was asked and replies with a queued response. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({
      url: String(url),
      target: headers["X-Amz-Target"],
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: "",
      text: async () => JSON.stringify(next.body),
    };
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const CLIENT_ID = "4ai1rbsjq376jp43kst5bdpbg";

function makeClient(responses: Array<{ status: number; body: unknown }>) {
  const { impl, calls } = fakeFetch(responses);
  return {
    calls,
    client: createCognitoClient({
      region: "us-east-1",
      userPoolClientId: CLIENT_ID,
      fetch: impl,
    }),
  };
}

const FULL_SESSION = {
  AuthenticationResult: {
    AccessToken: "access",
    IdToken: "id",
    RefreshToken: "refresh",
    ExpiresIn: 3600,
  },
};

describe("sign-in", () => {
  it("posts USER_PASSWORD_AUTH to the pool's regional endpoint", async () => {
    const { client, calls } = makeClient([{ status: 200, body: FULL_SESSION }]);

    const result = await client.signIn("a@example.com", "hunter2");

    expect(calls[0].url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect(calls[0].target).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(calls[0].body).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: "a@example.com", PASSWORD: "hunter2" },
    });
    expect(result).toEqual({
      kind: "tokens",
      tokens: { accessToken: "access", idToken: "id", refreshToken: "refresh", expiresIn: 3600 },
    });
  });

  it("reports a temporary password as a challenge rather than a failure", async () => {
    // The state a freshly-created user is in. Reporting it as bad credentials
    // would send someone hunting for a password that was never wrong.
    const { client } = makeClient([
      { status: 200, body: { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "sess-1" } },
    ]);

    expect(await client.signIn("a@example.com", "Temp!")).toEqual({
      kind: "new-password-required",
      session: "sess-1",
    });
  });

  it("names a challenge it cannot answer", async () => {
    const { client } = makeClient([
      { status: 200, body: { ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s" } },
    ]);

    await expect(client.signIn("a@example.com", "x")).rejects.toThrow(/SOFTWARE_TOKEN_MFA/);
  });

  it("surfaces Cognito's own error code and message", async () => {
    const { client } = makeClient([
      {
        status: 400,
        body: { __type: "NotAuthorizedException", message: "Incorrect username or password." },
      },
    ]);

    await expect(client.signIn("a@example.com", "wrong")).rejects.toMatchObject({
      code: "NotAuthorizedException",
      message: "Incorrect username or password.",
      status: 400,
    });
  });

  it("carries the HTTP status, which is what separates a rejection from an outage", async () => {
    // `session-manager` clears a stored token on 4xx and keeps it otherwise, so
    // a 5xx losing its status here would sign devices out during a Cognito
    // incident.
    const { client } = makeClient([
      { status: 503, body: { __type: "InternalErrorException", message: "unavailable" } },
    ]);

    await expect(client.refresh("r")).rejects.toMatchObject({ status: 503 });
  });

  it("strips the ARN prefix some error types carry", async () => {
    const { client } = makeClient([
      {
        status: 400,
        body: { __type: "com.amazon.coral.service#InvalidParameterException", message: "no" },
      },
    ]);

    await expect(client.signIn("a@example.com", "x")).rejects.toMatchObject({
      code: "InvalidParameterException",
    });
  });
});

describe("new password challenge", () => {
  it("answers with the session it was given", async () => {
    const { client, calls } = makeClient([{ status: 200, body: FULL_SESSION }]);

    const tokens = await client.setNewPassword("a@example.com", "sess-1", "N3wPassword!");

    expect(calls[0].target).toBe("AWSCognitoIdentityProviderService.RespondToAuthChallenge");
    expect(calls[0].body).toEqual({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ClientId: CLIENT_ID,
      Session: "sess-1",
      ChallengeResponses: { USERNAME: "a@example.com", NEW_PASSWORD: "N3wPassword!" },
    });
    expect(tokens.accessToken).toBe("access");
  });

  it("rejects a policy-violating password with Cognito's explanation", async () => {
    const { client } = makeClient([
      {
        status: 400,
        body: {
          __type: "InvalidPasswordException",
          message: "Password did not conform with policy: too short",
        },
      },
    ]);

    await expect(client.setNewPassword("a@example.com", "s", "x")).rejects.toThrow(/too short/);
  });
});

describe("refresh", () => {
  it("carries the caller's refresh token through, since Cognito does not return it", async () => {
    // The trap this guards: REFRESH_TOKEN_AUTH replies without a RefreshToken,
    // so a client that read one straight off the response would store
    // `undefined` and be signed out on the next launch.
    const { client, calls } = makeClient([
      {
        status: 200,
        body: { AuthenticationResult: { AccessToken: "a2", IdToken: "i2", ExpiresIn: 3600 } },
      },
    ]);

    const tokens = await client.refresh("stored-refresh");

    expect(calls[0].body).toEqual({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: "stored-refresh" },
    });
    expect(tokens).toEqual({
      accessToken: "a2",
      idToken: "i2",
      refreshToken: "stored-refresh",
      expiresIn: 3600,
    });
  });

  it("fails loudly on a session missing tokens", async () => {
    const { client } = makeClient([{ status: 200, body: { AuthenticationResult: {} } }]);

    await expect(client.refresh("r")).rejects.toBeInstanceOf(CognitoError);
  });
});

describe("revoke", () => {
  it("posts RevokeToken with the token and the client id, and nothing else", async () => {
    // A public client needs no secret and no AWS credentials to revoke its own
    // token, which is what makes sign-out revocation possible from a phone.
    const { client, calls } = makeClient([{ status: 200, body: {} }]);

    await client.revoke("refresh-1");

    expect(calls[0]!.target).toBe("AWSCognitoIdentityProviderService.RevokeToken");
    expect(calls[0]!.body).toEqual({ Token: "refresh-1", ClientId: CLIENT_ID });
  });

  it("carries a refusal's status, so a caller can tell it from an outage", async () => {
    const { client } = makeClient([
      { status: 400, body: { __type: "UnauthorizedException", message: "Token revoked" } },
    ]);

    await expect(client.revoke("dead")).rejects.toMatchObject({
      code: "UnauthorizedException",
      status: 400,
    });
  });
});

describe("idTokenClaims", () => {
  /** A JWT's shape, with only the claims segment meaningful. */
  function idTokenWith(claims: unknown): string {
    const payload = Buffer.from(JSON.stringify(claims), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `header.${payload}.signature`;
  }

  it("reads the email claim", () => {
    expect(emailFromIdToken(idTokenWith({ email: "aaron@example.com", sub: "1" }))).toBe(
      "aaron@example.com",
    );
  });

  it("decodes base64url padding and the - and _ substitutions", () => {
    // Claims chosen so the base64 needs padding and produces both substituted
    // characters — the reason this decodes by hand rather than trusting `atob`.
    const email = "aaa?b>c@example.com";
    expect(emailFromIdToken(idTokenWith({ email }))).toBe(email);
  });

  it("reads the sub and the expiry", () => {
    expect(idTokenClaims(idTokenWith({ sub: "u-1", exp: 1_800_000_000 }))).toEqual({
      sub: "u-1",
      email: null,
      exp: 1_800_000_000,
      groups: [],
    });
  });

  it("reads the account's groups, and ignores anything that is not a string", () => {
    const claims = idTokenClaims(
      idTokenWith({ sub: "u-1", "cognito:groups": ["starkeep-users", 7, "starkeep-admins"] }),
    );
    expect(claims.groups).toEqual(["starkeep-users", "starkeep-admins"]);
    expect(
      idTokenClaims(idTokenWith({ sub: "u-1", "cognito:groups": "starkeep-users" })).groups,
    ).toEqual([]);
  });

  it("returns null rather than throwing on anything unreadable", () => {
    expect(emailFromIdToken("not-a-jwt")).toBeNull();
    expect(emailFromIdToken("header.!!!!.sig")).toBeNull();
    expect(emailFromIdToken(idTokenWith({ sub: "1" }))).toBeNull();
  });
});
