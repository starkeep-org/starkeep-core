/**
 * The platform's sign-in pages for cloud apps (todo #66).
 *
 * These routes exist so that no app's code ever receives a password. What they
 * must get right is narrow: a sign-in returns only to the app that started it,
 * only under that app's own path, only for the browser that started it, and
 * sets cookies only at that app's mount.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand, ParameterNotFound } from "@aws-sdk/client-ssm";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import {
  handleSignInRoute,
  isReturnPathFor,
  pkceChallenge,
  type SignInRouteDeps,
  type SignInResponse,
} from "../src/sign-in-routes.js";
import { installUserTokenFixture, mintTestUserToken, TEST_CLIENT_ID } from "./user-token.js";

const ssmMock = mockClient(SSMClient);
const DOMAIN = "teststack-123.auth.us-east-1.amazoncognito.com";
const BASE = "https://d1.cloudfront.net";

let deps: SignInRouteDeps;
let tokenRequests: Array<{ url: string; body: URLSearchParams }>;
let tokenAnswer: () => Response;

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await installUserTokenFixture();
  process.env.STARKEEP_COGNITO_DOMAIN = DOMAIN;
});

beforeEach(async () => {
  tokenRequests = [];
  const idToken = await mintTestUserToken();
  tokenAnswer = () =>
    new Response(
      JSON.stringify({ id_token: idToken, refresh_token: "refresh-1", expires_in: 3600 }),
      { status: 200 },
    );
  deps = {
    publicBaseUrl: async () => BASE,
    isInstalled: async (appId) => appId === "photos" || appId === "memo",
    fetch: (async (url: string, init?: RequestInit) => {
      tokenRequests.push({ url, body: new URLSearchParams(String(init?.body)) });
      return tokenAnswer();
    }) as unknown as typeof fetch,
  };
});

function get(
  rawPath: string,
  query: Record<string, string> = {},
  cookieHeader?: string,
): Promise<SignInResponse> {
  return handleSignInRoute({ method: "GET", rawPath, query, cookieHeader }, deps);
}

/** `name=value` pairs a browser would send back from a response's cookies. */
function jar(res: SignInResponse): string {
  return (res.cookies ?? [])
    .map((c) => c.split(";")[0]!)
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

async function started(app = "photos", ret = "/apps/photos/") {
  const res = await get("/auth/start", { app, return: ret });
  expect(res.statusCode).toBe(302);
  const location = new URL(res.headers.Location!);
  return { res, location, cookie: jar(res), state: location.searchParams.get("state")! };
}

describe("/auth/start", () => {
  it("sends the browser to the managed login page with PKCE, on the cloud-apps client", async () => {
    const { res, location } = await started();
    expect(location.origin).toBe(`https://${DOMAIN}`);
    expect(location.pathname).toBe("/oauth2/authorize");
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: "code",
      client_id: TEST_CLIENT_ID,
      redirect_uri: `${BASE}/auth/callback`,
      scope: "openid email",
      code_challenge_method: "S256",
    });
    const pending = res.cookies!.find((c) => c.startsWith("sk_sign_in="))!;
    expect(pending).toContain("Path=/auth");
    expect(pending).toContain("HttpOnly");
    expect(pending).toContain("Max-Age=600");
  });

  it("refuses an app that is not installed", async () => {
    expect((await get("/auth/start", { app: "nope", return: "/apps/nope/" })).statusCode).toBe(404);
  });

  it("refuses the apps with no browser surface", async () => {
    deps.isInstalled = async () => true;
    for (const app of ["starkeep-drive", "cloud-data-server"]) {
      expect((await get("/auth/start", { app, return: `/apps/${app}/` })).statusCode).toBe(400);
    }
  });

  it("refuses a return path outside the app's mount", async () => {
    for (const ret of [
      "https://evil.example.com/",
      "//evil.example.com/apps/photos/",
      "/apps/memo/",
      "/apps/photos-evil/",
      "/apps/photos/../memo/",
      "/apps/photos/%2e%2e/memo/",
      "/apps/photos/\\evil",
      "/apps/photos//evil.example.com",
    ]) {
      const res = await get("/auth/start", { app: "photos", return: ret });
      expect(res.statusCode, ret).toBe(400);
      expect(res.cookies ?? []).toEqual([]);
    }
  });

  it("answers 503 when the deployment has no sign-in page", async () => {
    delete process.env.STARKEEP_COGNITO_DOMAIN;
    try {
      expect(
        (await get("/auth/start", { app: "photos", return: "/apps/photos/" })).statusCode,
      ).toBe(503);
    } finally {
      process.env.STARKEEP_COGNITO_DOMAIN = DOMAIN;
    }
  });
});

describe("/auth/callback", () => {
  it("exchanges the code with the verifier and sets cookies only at the app's mount", async () => {
    const { location, cookie, state } = await started("photos", "/apps/photos/album/1?x=y");
    const res = await get("/auth/callback", { code: "the-code", state }, cookie);

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe("/apps/photos/album/1?x=y");
    const [exchange] = tokenRequests;
    expect(exchange!.url).toBe(`https://${DOMAIN}/oauth2/token`);
    expect(exchange!.body.get("grant_type")).toBe("authorization_code");
    expect(exchange!.body.get("code")).toBe("the-code");
    expect(exchange!.body.get("redirect_uri")).toBe(`${BASE}/auth/callback`);
    // The verifier matches the challenge the authorize request carried.
    expect(pkceChallenge(exchange!.body.get("code_verifier")!)).toBe(
      location.searchParams.get("code_challenge"),
    );

    const session = res.cookies!.find((c) => c.startsWith("sk_session="))!;
    const token = res.cookies!.find((c) => c.startsWith("sk_token="))!;
    expect(session).toContain("Path=/apps/photos;");
    expect(session).toContain("refresh-1");
    expect(session).toContain("HttpOnly");
    expect(token).toContain("Path=/apps/photos;");
    // The attempt is spent.
    expect(res.cookies!.find((c) => c.startsWith("sk_sign_in="))).toContain("Max-Age=0");
    // No token reaches the page.
    expect(res.body).toBe("");
  });

  it("refuses a missing or mismatched state, and exchanges nothing", async () => {
    const { cookie } = await started();
    expect((await get("/auth/callback", { code: "c" }, cookie)).statusCode).toBe(400);
    expect((await get("/auth/callback", { code: "c", state: "forged" }, cookie)).statusCode).toBe(
      400,
    );
    // A browser that never started this sign-in holds no cookie at all.
    expect((await get("/auth/callback", { code: "c", state: "x" })).statusCode).toBe(400);
    expect(tokenRequests).toEqual([]);
  });

  it("re-checks the app and return path the cookie names, since the browser can write it", async () => {
    const forged = Buffer.from(
      JSON.stringify({
        state: "s",
        verifier: "v",
        app: "photos",
        return: "https://evil.example.com/",
      }),
    ).toString("base64url");
    const res = await get("/auth/callback", { code: "c", state: "s" }, `sk_sign_in=${forged}`);
    expect(res.statusCode).toBe(400);
    expect(tokenRequests).toEqual([]);
  });

  it("refuses a session from another client, and sets no cookie", async () => {
    const foreign = await mintTestUserToken({ aud: "admin-client" });
    tokenAnswer = () =>
      new Response(JSON.stringify({ id_token: foreign, refresh_token: "r", expires_in: 3600 }));
    const { cookie, state } = await started();
    const res = await get("/auth/callback", { code: "c", state }, cookie);
    expect(res.statusCode).toBe(400);
    expect(res.cookies!.some((c) => c.startsWith("sk_session=") && !c.includes("Max-Age=0"))).toBe(
      false,
    );
  });

  it("reports the managed login page's error rather than exchanging", async () => {
    const { cookie, state } = await started();
    const res = await get(
      "/auth/callback",
      { state, error: "access_denied", error_description: "User cancelled" },
      cookie,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("User cancelled");
    expect(tokenRequests).toEqual([]);
  });

  it("reports a refused exchange as a page, not a server error", async () => {
    tokenAnswer = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const { cookie, state } = await started();
    expect((await get("/auth/callback", { code: "c", state }, cookie)).statusCode).toBe(400);
  });
});

describe("/auth/sign-out and /auth/signed-out", () => {
  it("clears the app's cookies and ends the managed login session", async () => {
    const res = await get("/auth/sign-out", { app: "memo" });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.Location!);
    expect(`${location.origin}${location.pathname}`).toBe(`https://${DOMAIN}/logout`);
    expect(location.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(location.searchParams.get("logout_uri")).toBe(`${BASE}/auth/signed-out`);
    const cleared = res.cookies!.filter((c) => c.includes("Path=/apps/memo;"));
    expect(cleared).toHaveLength(2);
    expect(cleared.every((c) => c.includes("Max-Age=0"))).toBe(true);

    const back = await get("/auth/signed-out", {}, jar(res));
    expect(back.statusCode).toBe(302);
    expect(back.headers.Location).toBe("/apps/memo/");
  });

  it("says signed out when it does not know which app to return to", async () => {
    const res = await get("/auth/signed-out");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("signed out");
  });
});

describe("isReturnPathFor", () => {
  it("accepts the mount itself and paths beneath it", () => {
    expect(isReturnPathFor("photos", "/apps/photos")).toBe(true);
    expect(isReturnPathFor("photos", "/apps/photos/")).toBe(true);
    expect(isReturnPathFor("photos", "/apps/photos?x=1")).toBe(true);
    expect(isReturnPathFor("photos", "/apps/photos/a/b?c=d#e")).toBe(true);
  });
});

describe("through the broker's handler", () => {
  const context: LambdaContext = {
    invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-cds",
  };

  beforeAll(() => {
    process.env.STACK_PREFIX = "teststack";
    process.env.CLOUDFRONT_SIGNING_PARAM = "/teststack/app-creds/cloudfront-signing";
    process.env.HMAC_CACHE_TTL_MS = "0";
  });

  beforeEach(() => {
    ssmMock.reset();
    ssmMock
      .on(GetParameterCommand)
      .rejects(new ParameterNotFound({ message: "not found", $metadata: {} }));
    ssmMock
      .on(GetParameterCommand, { Name: "/teststack/app-creds/photos" })
      .resolves({ Parameter: { Value: JSON.stringify({ hmacSecret: "s" }) } });
    ssmMock.on(GetParameterCommand, { Name: process.env.CLOUDFRONT_SIGNING_PARAM }).resolves({
      Parameter: {
        Value: JSON.stringify({ keyPairId: "K", domain: "d1.cloudfront.net", privateKey: "P" }),
      },
    });
  });

  it("answers /auth/start before any app path is parsed, with the distribution's callback", async () => {
    const { handler } = await import("../src/api-handler.js");
    const event: APIGatewayEvent = {
      rawPath: "/auth/start",
      requestContext: { http: { method: "GET" } },
      queryStringParameters: { app: "photos", return: "/apps/photos/" },
    };
    const res = (await handler(event, context)) as SignInResponse;
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.Location!).searchParams.get("redirect_uri")).toBe(
      "https://d1.cloudfront.net/auth/callback",
    );
  });

  it("reads the callback's cookie from the v2 payload's cookies array", async () => {
    const { handler } = await import("../src/api-handler.js");
    const start = (await handler(
      {
        rawPath: "/auth/start",
        requestContext: { http: { method: "GET" } },
        queryStringParameters: { app: "photos", return: "/apps/photos/" },
      },
      context,
    )) as SignInResponse;
    const state = new URL(start.headers.Location!).searchParams.get("state")!;
    const res = (await handler(
      {
        rawPath: "/auth/callback",
        requestContext: { http: { method: "GET" } },
        queryStringParameters: { state, error: "access_denied" },
        cookies: [jar(start)],
      },
      context,
    )) as SignInResponse;
    // Past the state check: the cookie was found and matched.
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("access_denied");
  });
});
