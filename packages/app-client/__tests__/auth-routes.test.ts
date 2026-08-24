/**
 * The session endpoints. These are the only place in the system that turns a
 * password into a durable credential, so what they set — and, on the challenge
 * and failure paths, what they deliberately do not set — is the contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSessionRoutes } from "../src/auth/routes.js";
import { SESSION_COOKIE, TOKEN_COOKIE } from "../src/auth/session.js";
import { clearJwksCache } from "../src/auth/verify.js";
import type { MinimalNextRequest } from "../src/next.js";
import { makeKey, signJwt, type TestKey } from "./auth-jwt.js";

const REGION = "us-east-2";
const POOL = "us-east-2_TESTPOOL";
const CLIENT = "client-abc";
const ORIGIN = "https://cdn.example.com";

let key: TestKey;
let idToken: string;
let cognitoCalls: { target: string; body: Record<string, unknown> }[];
const saved = { ...process.env };
const routes = createSessionRoutes({ appId: "memo" });

function idClaims(over: Record<string, unknown> = {}) {
  return {
    iss: `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`,
    aud: CLIENT,
    token_use: "id",
    sub: "user-1",
    email: "a@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}

function req(
  opts: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {},
): MinimalNextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  return {
    method: opts.method ?? "POST",
    url: `${ORIGIN}/apps/memo/api/session/sign-in`,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    text: async () => (opts.body === undefined ? "" : JSON.stringify(opts.body)),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

const ctx = (...action: string[]) => ({ params: Promise.resolve({ action }) });

/** Cognito answers with `next`; every JWKS request answers with the test key. */
function stubCognito(next: (target: string, body: Record<string, unknown>) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
      }
      const target = String((init?.headers as Record<string, string>)["X-Amz-Target"]);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      cognitoCalls.push({ target, body });
      return next(target, body);
    }),
  );
}

function cookiesOf(res: Response): string[] {
  return res.headers.getSetCookie();
}

beforeEach(async () => {
  key ??= await makeKey("kid-1");
  idToken = await signJwt(key, idClaims());
  clearJwksCache();
  cognitoCalls = [];
  process.env.AWS_REGION = REGION;
  process.env.STARKEEP_USER_POOL_ID = POOL;
  process.env.STARKEEP_USER_POOL_CLIENT_ID = CLIENT;
  stubCognito(
    () =>
      new Response(
        JSON.stringify({
          AuthenticationResult: {
            IdToken: idToken,
            AccessToken: "access",
            RefreshToken: "refresh-abc",
            ExpiresIn: 3600,
          },
        }),
        { status: 200 },
      ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
});

describe("POST sign-in", () => {
  it("sets both cookies on success and returns no token to the page", async () => {
    const res = await routes.POST(
      req({ body: { email: "a@example.com", password: "pw" } }),
      ctx("sign-in"),
    );
    expect(res.status).toBe(200);

    const cookies = cookiesOf(res);
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const token = cookies.find((c) => c.startsWith(`${TOKEN_COOKIE}=`));
    expect(session).toContain("HttpOnly");
    expect(session).toContain("refresh-abc");
    expect(token).toContain("HttpOnly");

    // The refresh token must not reach the page in the body either — the
    // cookie being HttpOnly buys nothing if the JSON hands it over.
    const body = await res.text();
    expect(body).not.toContain("refresh-abc");
    expect(JSON.parse(body)).toEqual({ signedIn: true, email: "a@example.com" });
  });

  it("uses the USER_PASSWORD_AUTH flow against the configured client", async () => {
    await routes.POST(req({ body: { email: "a@example.com", password: "pw" } }), ctx("sign-in"));
    expect(cognitoCalls[0].target).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(cognitoCalls[0].body).toMatchObject({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT,
    });
  });

  it("returns NEW_PASSWORD_REQUIRED without setting any cookie", async () => {
    stubCognito(
      () =>
        new Response(
          JSON.stringify({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "sess-1" }),
          { status: 200 },
        ),
    );
    const res = await routes.POST(
      req({ body: { email: "a@example.com", password: "temp" } }),
      ctx("sign-in"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "NEW_PASSWORD_REQUIRED", session: "sess-1" });
    expect(cookiesOf(res)).toEqual([]);
  });

  it("reports a bad password as 401, not as a server error", async () => {
    stubCognito(
      () =>
        new Response(
          JSON.stringify({ __type: "NotAuthorizedException", message: "Incorrect username or password." }),
          { status: 400 },
        ),
    );
    const res = await routes.POST(
      req({ body: { email: "a@example.com", password: "wrong" } }),
      ctx("sign-in"),
    );
    expect(res.status).toBe(401);
    expect(cookiesOf(res)).toEqual([]);
  });

  it("reports a Cognito outage as 502, so it is not read as a rejected sign-in", async () => {
    stubCognito(() => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
    const res = await routes.POST(
      req({ body: { email: "a@example.com", password: "pw" } }),
      ctx("sign-in"),
    );
    expect(res.status).toBe(502);
  });

  it("requires both fields", async () => {
    expect((await routes.POST(req({ body: { email: "a@e.com" } }), ctx("sign-in"))).status).toBe(400);
    expect((await routes.POST(req({ body: {} }), ctx("sign-in"))).status).toBe(400);
  });

  it("answers 503 when the deployment has no user pool", async () => {
    delete process.env.STARKEEP_USER_POOL_ID;
    const res = await routes.POST(
      req({ body: { email: "a@example.com", password: "pw" } }),
      ctx("sign-in"),
    );
    expect(res.status).toBe(503);
  });
});

describe("POST new-password", () => {
  it("sets both cookies once the challenge is answered", async () => {
    const res = await routes.POST(
      req({ body: { session: "sess-1", email: "a@example.com", newPassword: "N3w!" } }),
      ctx("new-password"),
    );
    expect(res.status).toBe(200);
    expect(cognitoCalls[0].target).toBe("AWSCognitoIdentityProviderService.RespondToAuthChallenge");
    expect(cookiesOf(res)).toHaveLength(2);
  });
});

describe("cross-origin", () => {
  it("refuses a state-changing request from a foreign origin", async () => {
    const res = await routes.POST(
      req({ body: { email: "a@example.com", password: "pw" }, origin: "https://evil.example.com" }),
      ctx("sign-in"),
    );
    expect(res.status).toBe(403);
    expect(cognitoCalls).toEqual([]);
  });

  it("allows a request with no Origin at all — curl and the e2e suite send none", async () => {
    const res = await routes.POST(
      req({ body: { email: "a@example.com", password: "pw" }, origin: null }),
      ctx("sign-in"),
    );
    expect(res.status).toBe(200);
  });

  it("allows the deployment's own browser-facing origin, which is not the request's", async () => {
    // The case a live browser found and no unit test could: behind CloudFront,
    // `Origin` is the distribution the person is on while `req.url` is the
    // origin server the gateway forwarded to. Comparing only those two refuses
    // every real sign-in while letting every Origin-less caller through.
    const saved = process.env.STARKEEP_API_GATEWAY_URL;
    process.env.STARKEEP_API_GATEWAY_URL = "https://cdn.example.net";
    try {
      const res = await routes.POST(
        req({ body: { email: "a@example.com", password: "pw" }, origin: "https://cdn.example.net" }),
        ctx("sign-in"),
      );
      expect(res.status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.STARKEEP_API_GATEWAY_URL;
      else process.env.STARKEEP_API_GATEWAY_URL = saved;
    }
  });

  it("still refuses a foreign origin when a public base is configured", async () => {
    const saved = process.env.STARKEEP_API_GATEWAY_URL;
    process.env.STARKEEP_API_GATEWAY_URL = "https://cdn.example.net";
    try {
      const res = await routes.POST(
        req({ body: { email: "a@example.com", password: "pw" }, origin: "https://evil.example.com" }),
        ctx("sign-in"),
      );
      expect(res.status).toBe(403);
      expect(cognitoCalls).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.STARKEEP_API_GATEWAY_URL;
      else process.env.STARKEEP_API_GATEWAY_URL = saved;
    }
  });

  it("grants no exemption when the configured public base is malformed", async () => {
    const saved = process.env.STARKEEP_API_GATEWAY_URL;
    process.env.STARKEEP_API_GATEWAY_URL = "not a url";
    try {
      const res = await routes.POST(
        req({ body: { email: "a@example.com", password: "pw" }, origin: "https://evil.example.com" }),
        ctx("sign-in"),
      );
      expect(res.status).toBe(403);
    } finally {
      if (saved === undefined) delete process.env.STARKEEP_API_GATEWAY_URL;
      else process.env.STARKEEP_API_GATEWAY_URL = saved;
    }
  });
});

describe("POST refresh", () => {
  it("issues a fresh token cookie from sk_session alone", async () => {
    const res = await routes.POST(req({ cookie: `${SESSION_COOKIE}=refresh-abc` }), ctx("refresh"));
    expect(res.status).toBe(200);
    const cookies = cookiesOf(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].startsWith(`${TOKEN_COOKIE}=`)).toBe(true);
  });

  it("clears both cookies when the refresh token is spent", async () => {
    stubCognito(() => new Response(JSON.stringify({ __type: "NotAuthorizedException" }), { status: 400 }));
    const res = await routes.POST(req({ cookie: `${SESSION_COOKIE}=spent` }), ctx("refresh"));
    expect(res.status).toBe(401);
    expect(cookiesOf(res).every((c) => c.includes("Max-Age=0"))).toBe(true);
  });

  it("401s with no session cookie", async () => {
    expect((await routes.POST(req(), ctx("refresh"))).status).toBe(401);
  });
});

describe("POST sign-out", () => {
  it("clears both cookies", async () => {
    const res = await routes.POST(req({ cookie: `${SESSION_COOKIE}=x` }), ctx("sign-out"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: false });
    expect(cookiesOf(res)).toHaveLength(2);
    expect(cookiesOf(res).every((c) => c.includes("Max-Age=0"))).toBe(true);
  });
});

describe("GET probe", () => {
  it("reports a signed-in caller", async () => {
    const res = await routes.GET(
      req({ method: "GET", cookie: `${TOKEN_COOKIE}=${idToken}` }),
      ctx(),
    );
    expect(await res.json()).toEqual({ signedIn: true, email: "a@example.com" });
  });

  it("reports a signed-out caller without erroring", async () => {
    const res = await routes.GET(req({ method: "GET" }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: false });
  });
});

describe("GET token", () => {
  it("hands out the id token for the one call a cookie cannot serve", async () => {
    const res = await routes.GET(
      req({ method: "GET", cookie: `${TOKEN_COOKIE}=${idToken}` }),
      ctx("token"),
    );
    const body = (await res.json()) as { accessToken: string; expiresIn: number };
    expect(body.accessToken).toBe(idToken);
    expect(body.expiresIn).toBeGreaterThan(0);
  });

  it("401s an anonymous caller rather than minting anything", async () => {
    expect((await routes.GET(req({ method: "GET" }), ctx("token"))).status).toBe(401);
  });
});

describe("unknown actions", () => {
  it("404s rather than falling through to a default", async () => {
    expect((await routes.POST(req(), ctx("wat"))).status).toBe(404);
    expect((await routes.GET(req({ method: "GET" }), ctx("wat"))).status).toBe(404);
    // A POST to the probe path is not a probe.
    expect((await routes.POST(req(), ctx())).status).toBe(404);
  });
});
