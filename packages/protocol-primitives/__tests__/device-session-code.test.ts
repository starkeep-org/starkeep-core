/**
 * The last step of a managed-login sign-in: redeeming the code, and the
 * discovery answer that names the page's host name.
 */
import { describe, expect, it } from "vitest";
import {
  CLI_CALLBACK_PORT,
  CognitoError,
  localCallbackUrls,
  parseDeviceAuthConfig,
  redeemAuthorizationCode,
} from "../src/index.js";

function tokenEndpoint(status: number, body: unknown) {
  const calls: Array<{ url: string; body: URLSearchParams; contentType: string }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: new URLSearchParams(String(init.body)),
      contentType: (init.headers as Record<string, string>)["Content-Type"]!,
    });
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const OPTIONS = {
  domain: "prefix-123456789012.auth.us-east-2.amazoncognito.com",
  clientId: "adminclient",
  code: "the-code",
  codeVerifier: "the-verifier",
  redirectUri: "http://localhost:3000/auth/callback",
};

describe("redeemAuthorizationCode", () => {
  it("posts the code, the verifier and the callback to the domain's token endpoint", async () => {
    const { impl, calls } = tokenEndpoint(200, {
      access_token: "a",
      id_token: "i",
      refresh_token: "r",
      expires_in: 900,
    });
    const tokens = await redeemAuthorizationCode({ ...OPTIONS, fetch: impl });
    expect(tokens).toEqual({ accessToken: "a", idToken: "i", refreshToken: "r", expiresIn: 900 });
    expect(calls[0]!.url).toBe(`https://${OPTIONS.domain}/oauth2/token`);
    expect(calls[0]!.contentType).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(calls[0]!.body)).toEqual({
      grant_type: "authorization_code",
      client_id: "adminclient",
      code: "the-code",
      code_verifier: "the-verifier",
      redirect_uri: OPTIONS.redirectUri,
    });
  });

  it("names Cognito's refusal, with its status", async () => {
    const { impl } = tokenEndpoint(400, { error: "invalid_grant" });
    const err = await redeemAuthorizationCode({ ...OPTIONS, fetch: impl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CognitoError);
    expect(err).toMatchObject({ code: "invalid_grant", status: 400 });
  });

  it("refuses an answer without a refresh token", async () => {
    const { impl } = tokenEndpoint(200, { access_token: "a", id_token: "i" });
    await expect(redeemAuthorizationCode({ ...OPTIONS, fetch: impl })).rejects.toMatchObject({
      code: "IncompleteAuthResult",
    });
  });
});

describe("the device discovery answer", () => {
  const BASE = {
    region: "us-east-2",
    userPoolId: "us-east-2_Abc",
    deviceClientId: "deviceclient",
  };

  it("carries the managed login domain when the cloud sends one", () => {
    expect(parseDeviceAuthConfig({ ...BASE, cognitoDomain: OPTIONS.domain })).toEqual({
      ...BASE,
      cognitoDomain: OPTIONS.domain,
    });
  });

  it("drops a domain that is not a bare host name, and keeps the rest", () => {
    expect(parseDeviceAuthConfig({ ...BASE, cognitoDomain: "https://evil.example/x" })).toEqual(
      BASE,
    );
    expect(parseDeviceAuthConfig(BASE)).toEqual(BASE);
  });
});

describe("the local callbacks", () => {
  it("names admin-web's route and the CLI's listener", () => {
    expect(localCallbackUrls()).toEqual([
      "http://localhost:3000/auth/callback",
      `http://localhost:${CLI_CALLBACK_PORT}/callback`,
    ]);
  });
});
