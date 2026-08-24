/**
 * Having decided a person is here, the proxy has to say so upstream.
 *
 * The cloud data plane requires a credential bound to a named end user on every
 * call. The proxy verified one and then forwarded only its HMAC, so every cloud
 * data call answered 401 "Missing X-Starkeep-User-Token" — the app
 * authenticated the user and then failed to mention them. No unit test saw it
 * because both halves were individually correct: the gate refused anonymous
 * callers, and the broker refused tokenless calls. Only a live request through
 * both showed the gap, which is why this file exists.
 *
 * Separate from `next-proxy-auth.test.ts` because that suite deliberately uses
 * the real credential loader to prove a rejected caller never causes the secret
 * to be read; here the loader is mocked so the request can get past it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createNextProxyHandler, type MinimalNextRequest } from "../src/index.js";

const proxyMock = vi.hoisted(() => ({ proxyToDataServer: vi.fn() }));
vi.mock("../src/proxy.js", () => proxyMock);
vi.mock("../src/proxy", () => proxyMock);

const sessionMock = vi.hoisted(() => ({ mintIdToken: vi.fn(), requireSession: vi.fn() }));
vi.mock("../src/auth/session.js", () => sessionMock);

const credsMock = vi.hoisted(() => ({
  loadAppCredentials: vi.fn(),
  clearAppCredentialsCache: vi.fn(),
}));
vi.mock("../src/credentials.js", () => credsMock);
vi.mock("../src/credentials", () => credsMock);

const savedMode = process.env.STARKEEP_APP_CLIENT_MODE;

beforeEach(() => {
  proxyMock.proxyToDataServer.mockReset();
  proxyMock.proxyToDataServer.mockResolvedValue({
    status: 200,
    headers: { "content-type": "application/json" },
    body: null,
  });
  sessionMock.mintIdToken.mockReset();
  credsMock.loadAppCredentials.mockReset();
  credsMock.loadAppCredentials.mockResolvedValue({
    appId: "testapp",
    hmacSecret: "s3cret",
    dataServerUrl: "https://gateway.example.com/apps/testapp",
  });
  process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.STARKEEP_APP_CLIENT_MODE;
  else process.env.STARKEEP_APP_CLIENT_MODE = savedMode;
});

function request(): MinimalNextRequest {
  return {
    method: "GET",
    url: "http://localhost:3000/api/local-data/data/records?limit=5",
    headers: { get: () => null },
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

const ctx = { params: Promise.resolve({ path: ["data", "records"] }) };

function handlerWithSession() {
  return createNextProxyHandler({
    appId: "testapp",
    endUserAuth: { auth: "session", verifySession: () => true },
  });
}

describe("the proxy carries the end user upstream", () => {
  it("forwards the minted ID token beside the signature", async () => {
    sessionMock.mintIdToken.mockResolvedValue({ token: "id-token-abc", claims: { sub: "u1", exp: 0 } });

    const res = await handlerWithSession()(request(), ctx);

    expect(res.status).toBe(200);
    expect(proxyMock.proxyToDataServer).toHaveBeenCalledTimes(1);
    expect(proxyMock.proxyToDataServer.mock.calls[0]![1].userToken).toBe("id-token-abc");
  });

  it("echoes the refreshed cookie when the token was re-minted mid-session", async () => {
    // A session outlives its ID token by a long way. Without echoing the
    // re-mint the browser keeps the stale one and pays for a Cognito round trip
    // on every later call — and the cookie the platform just minted is thrown
    // away.
    sessionMock.mintIdToken.mockResolvedValue({
      token: "fresh-token",
      claims: { sub: "u1", exp: 0 },
      setCookie: "sk_token=fresh-token; Path=/apps/testapp; HttpOnly",
    });

    const res = await handlerWithSession()(request(), ctx);

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("sk_token=fresh-token"))).toBe(true);
  });

  it("sends no token header on the local surface, where no end user is asked for", async () => {
    delete process.env.STARKEEP_APP_CLIENT_MODE;

    const res = await handlerWithSession()(request(), ctx);

    expect(res.status).toBe(200);
    expect(sessionMock.mintIdToken).not.toHaveBeenCalled();
    expect(proxyMock.proxyToDataServer.mock.calls[0]![1].userToken).toBeUndefined();
  });
});
