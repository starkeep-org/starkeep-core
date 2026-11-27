/**
 * The managed login page's way in and back: `/auth/start` and `/auth/callback`.
 *
 * The start sends the browser to the page with a PKCE challenge and a `state`
 * only this server knows. The callback accepts only a sign-in this server
 * started, redeems an admin code into the shared session, hands a device code
 * to the local data server, and returns the browser to a path on admin-web
 * itself.
 */
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pkceChallenge } from "@starkeep/operator/oauth";
import { makeDataDir, writeAdminConfig } from "./helpers";
import { signOutFake } from "./fake-admin-session";

vi.mock("@starkeep/operator/admin-session", async (original) =>
  (await import("./fake-admin-session")).fakeAdminSessionModule(await original()),
);

const DOMAIN = "sk-123456789012.auth.us-east-2.amazoncognito.com";
const dataDir = makeDataDir("adminweb-auth-routes-");
process.env.STARKEEP_DIR = dataDir;

/** A stand-in for the token endpoint and the local data server's /auth/login. */
let endpoint: Server;
let tokenRequests: URLSearchParams[] = [];
let loginBodies: unknown[] = [];
let loginStatus = 200;

let route: typeof import("../src/routes/auth");
let session: typeof import("@starkeep/operator/admin-session");

/** The error the fake login page answers the authorize request with, or null to accept it. */
let authorizeRefusal: string | null = null;

beforeAll(async () => {
  endpoint = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      if (req.url?.startsWith("/oauth2/authorize")) {
        res.writeHead(302, {
          Location: authorizeRefusal ? `/error?error=${authorizeRefusal}` : "/login",
        });
        res.end();
        return;
      }
      if (req.url === "/oauth2/token") {
        tokenRequests.push(new URLSearchParams(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ access_token: "a", id_token: "i", refresh_token: "r", expires_in: 900 }),
        );
        return;
      }
      if (req.url === "/auth/login") {
        loginBodies.push(JSON.parse(body));
        res.writeHead(loginStatus, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            loginStatus === 200 ? { ok: true } : { error: "library belongs to another account" },
          ),
        );
        return;
      }
      if (req.url === "/auth/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            region: "us-east-2",
            userPoolId: "us-east-2_POOL",
            deviceClientId: "deviceclient",
            cognitoDomain: DOMAIN,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`;
  process.env.STARKEEP_COGNITO_TOKEN_ENDPOINT = `${base}/oauth2/token`;
  process.env.STARKEEP_COGNITO_LOGIN_BASE = base;
  process.env.STARKEEP_LOCAL_DATA_SERVER_URL = base;
  writeAdminConfig(dataDir, {
    stackPrefix: "sk",
    userPoolId: "us-east-2_POOL",
    userPoolClientId: "adminclient",
    identityPoolId: "us-east-2:pool",
    cognitoDomain: DOMAIN,
    apiGatewayUrl: base,
  });
  route = await import("../src/routes/auth");
  session = await import("@starkeep/operator/admin-session");
});

afterEach(() => {
  route.forgetPendingSignIns();
  tokenRequests = [];
  loginBodies = [];
  loginStatus = 200;
  vi.mocked(session.saveAdminSignIn).mockClear();
});

afterAll(() => endpoint.close());

const start = (query: string, port = 3000) =>
  route.START(new Request(`http://localhost:${port}/auth/start?${query}`));

function location(res: Response): URL {
  return new URL(res.headers.get("location")!, "http://localhost:3000");
}

/** Start a sign-in and return what the page would send back. */
async function begin(client: "admin" | "device", returnTo = "/cloud-setup") {
  const res = await start(`client=${client}&returnTo=${encodeURIComponent(returnTo)}`);
  expect(res.status).toBe(302);
  const page = location(res);
  return { page, state: page.searchParams.get("state")! };
}

const callback = (query: string) =>
  route.CALLBACK(new Request(`http://localhost:3000/auth/callback?${query}`));

describe("GET /auth/start", () => {
  it("sends the browser to the managed login page for the admin client, with PKCE", async () => {
    const { page } = await begin("admin");
    expect(page.origin).toBe(`https://${DOMAIN}`);
    expect(page.pathname).toBe("/oauth2/authorize");
    expect(page.searchParams.get("client_id")).toBe("adminclient");
    expect(page.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/callback");
    expect(page.searchParams.get("code_challenge_method")).toBe("S256");
    expect(page.searchParams.get("scope")).toBe("openid email");
    // An admin sign-in always asks for the password (ACCESS-199).
    expect(page.searchParams.get("prompt")).toBe("login");
  });

  it("names the old bootstrap stack when the login page refuses the sign-in", async () => {
    authorizeRefusal = "redirect_mismatch";
    try {
      const res = await start("client=admin&returnTo=%2Fcloud-setup");
      expect(location(res).pathname).toBe("/cloud-setup");
      expect(location(res).searchParams.get("signInError")).toContain(
        "The managed login page refused this sign-in (redirect_mismatch).",
      );
    } finally {
      authorizeRefusal = null;
    }
  });

  it("asks the cloud for the device client, as a machine that only joined knows its address", async () => {
    const { page } = await begin("device");
    expect(page.searchParams.get("client_id")).toBe("deviceclient");
    expect(page.searchParams.get("prompt")).toBeNull();
  });

  it("refuses on a port Cognito does not return to, and says to use the CLI", async () => {
    const res = await start("client=admin", 3999);
    expect(location(res).searchParams.get("signInError")).toMatch(/port 3999.*starkeep login/);
  });

  it("refuses a sign-in that another site started, so a page elsewhere cannot sign this computer in", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await route.START(
        new Request("http://localhost:3000/auth/start?client=device&returnTo=/", {
          headers: { "sec-fetch-site": site },
        }),
      );
      expect(res.status).toBe(302);
      expect(location(res).host).toBe("localhost:3000");
      expect(location(res).searchParams.get("signInError")).toMatch(/admin-web's own page/);
    }
  });

  it("starts a sign-in from admin-web's own page, or from an address typed in the browser", async () => {
    for (const site of ["same-origin", "none"]) {
      const res = await route.START(
        new Request("http://localhost:3000/auth/start?client=admin", {
          headers: { "sec-fetch-site": site },
        }),
      );
      expect(location(res).origin).toBe(`https://${DOMAIN}`);
    }
  });

  it("never returns to another site", async () => {
    const res = await start(`client=nope&returnTo=${encodeURIComponent("//evil.example/x")}`);
    expect(location(res).pathname).toBe("/");
    expect(location(res).host).toBe("localhost:3000");
  });
});

describe("GET /auth/callback", () => {
  it("refuses a state this server did not start, and redeems nothing", async () => {
    const res = await callback("code=planted&state=unknown");
    expect(location(res).searchParams.get("signInError")).toMatch(/did not start here/);
    expect(tokenRequests).toHaveLength(0);
  });

  it("redeems an admin code with the verifier and keeps the session", async () => {
    const { page, state } = await begin("admin", "/cloud-setup");
    const res = await callback(`code=the-code&state=${state}`);
    expect(location(res).pathname).toBe("/cloud-setup");
    expect(location(res).searchParams.get("signedIn")).toBe("admin");
    const form = Object.fromEntries(tokenRequests[0]!);
    expect(form).toMatchObject({ client_id: "adminclient", code: "the-code" });
    expect(pkceChallenge(form.code_verifier!)).toBe(page.searchParams.get("code_challenge"));
    expect(session.saveAdminSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "r", idToken: "i" }),
    );
  });

  it("accepts each state once", async () => {
    const { state } = await begin("admin");
    await callback(`code=c&state=${state}`);
    const again = await callback(`code=c&state=${state}`);
    expect(location(again).searchParams.get("signInError")).toBeTruthy();
    expect(tokenRequests).toHaveLength(1);
  });

  it("hands a device code to the local data server, which redeems it", async () => {
    const { state } = await begin("device", "/");
    const res = await callback(`code=dev-code&state=${state}`);
    expect(location(res).searchParams.get("signedIn")).toBe("device");
    expect(loginBodies).toEqual([
      expect.objectContaining({
        code: "dev-code",
        redirectUri: "http://localhost:3000/auth/callback",
      }),
    ]);
    expect(tokenRequests).toHaveLength(0);
  });

  it("returns the local data server's refusal to the page", async () => {
    loginStatus = 409;
    const { state } = await begin("device", "/");
    const res = await callback(`code=dev-code&state=${state}`);
    expect(location(res).searchParams.get("signInError")).toMatch(/another account/);
  });

  it("passes on the page's own error", async () => {
    const { state } = await begin("admin");
    const res = await callback(`error=access_denied&error_description=Cancelled&state=${state}`);
    expect(location(res).searchParams.get("signInError")).toBe("Cancelled");
  });
});

describe("GET /api/admin-session", () => {
  it("says whether an admin is signed in and whether a browser sign-in can return here", async () => {
    const here = await (
      await route.SESSION(new Request("http://localhost:3000/api/admin-session"))
    ).json();
    expect(here).toMatchObject({ signedIn: true, browserSignIn: { available: true } });
    signOutFake();
    const elsewhere = await (
      await route.SESSION(new Request("http://localhost:3999/api/admin-session"))
    ).json();
    expect(elsewhere).toMatchObject({ signedIn: false, browserSignIn: { available: false } });
  });
});
