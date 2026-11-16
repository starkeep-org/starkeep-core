/**
 * The OAuth authorization endpoint, the consent page and the approval,
 * against a fake Cognito, a scripted database and a scripted client
 * metadata document.
 *
 * A bad client or redirect URI renders an error page and never redirects.
 * Every other bad request redirects to the client with `error`, `state` and
 * `iss`. A good one signs in, stores the request with its sealed refresh
 * token, and shows a consent page naming the account, the client's hosts and
 * the app. The approval issues a code; a denial revokes the refresh token.
 */
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleConnectRoute,
  type ConnectDeps,
  type ConnectRequest,
  type ConnectResponse,
} from "../src/connect-routes.js";
import {
  delegationSigningKeyFromPem,
  openRefreshToken,
  sealRefreshToken,
} from "../src/delegation-tokens.js";
import { hashCode, resetAuthorizationCleanup } from "../src/oauth-authorize.js";
import { resetClientCache, type FetchedDocument } from "../src/oauth-clients.js";
import { FakeDsql, type LoggedQuery } from "./fake-dsql.js";
import { makeDelegationKeyPem } from "./delegation-key.js";
import {
  installUserTokenFixture,
  mintTestUserToken,
  TEST_POOL_ID,
  TEST_REGION,
  TEST_USER_ID,
} from "./user-token.js";

const HOST = "abc123.execute-api.us-east-1.amazonaws.com";
const ISSUER = `https://${HOST}`;
const COGNITO = "teststack.auth.us-east-1.amazoncognito.com";
const CONNECTORS = "test-connectors-client";
const CLIENT = "https://client.example/oauth/metadata.json";
const REDIRECT = "https://client.example/callback";
const RESOURCE = "https://cloud.example.com/apps/probe/mcp";
const CHALLENGE = createHash("sha256").update("verifier-verifier-verifier").digest("base64url");
const key = delegationSigningKeyFromPem(makeDelegationKeyPem().privateKeyPem);

let db: FakeDsql;
let cognitoCalls: { url: string; body: URLSearchParams }[];
let groups: string[];
let clientDoc: () => FetchedDocument;
/** The authorization rows the scripted database holds, by id. */
let rows: Map<string, Record<string, unknown>>;

function deps(): ConnectDeps {
  return {
    pool: { region: TEST_REGION, userPoolId: TEST_POOL_ID, userPoolClientId: CONNECTORS },
    cognitoDomain: COGNITO,
    host: HOST,
    signingKey: async () => key,
    db: async () => db.createClient({ hostname: "x", region: "x" }),
    connectableApps: async () => [{ appId: "probe", name: "Probe", delegatedPaths: ["/mcp"] }],
    viewerHosts: async () => ["cloud.example.com", "d111.cloudfront.net"],
    groupsMayUseData: (g) => g.includes("starkeep-users"),
    forgetDelegation: () => {},
    clients: { fetchDocument: async () => clientDoc() },
    fetch: async (input, init) => {
      const url = String(input);
      const body = new URLSearchParams(String(init?.body ?? ""));
      cognitoCalls.push({ url, body });
      if (url.endsWith("/oauth2/token")) {
        return new Response(
          JSON.stringify({
            id_token: await mintTestUserToken({
              aud: CONNECTORS,
              "cognito:groups": groups,
              email: "ada@example.com",
            }),
            refresh_token: `refresh-for-${body.get("code")}`,
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    },
  };
}

function req(over: Partial<ConnectRequest>): ConnectRequest {
  return {
    method: "GET",
    rawPath: "/connect/authorize",
    query: {},
    headers: {},
    cookieHeader: undefined,
    body: "",
    ...over,
  };
}

function authorizeQuery(over: Record<string, string | undefined> = {}) {
  const q: Record<string, string | undefined> = {
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "read",
    state: "client-state",
    ...over,
  };
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined));
}

function jar(res: ConnectResponse, prior = ""): string {
  const set = Object.fromEntries(
    prior
      .split("; ")
      .filter(Boolean)
      .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]),
  );
  for (const c of res.cookies ?? []) {
    const pair = c.split(";", 1)[0]!;
    const name = pair.slice(0, pair.indexOf("="));
    if (/Max-Age=0/.test(c)) delete set[name];
    else set[name] = pair.slice(pair.indexOf("=") + 1);
  }
  return Object.entries(set)
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");
}

/** The columns a Kysely insert names, zipped with its values. */
function inserted(q: LoggedQuery): Record<string, unknown> {
  const columns = /\(([^)]+)\) values/
    .exec(q.text)![1]!
    .split(", ")
    .map((c) => c.slice(1, -1));
  return Object.fromEntries(columns.map((c, i) => [c, q.values[i]]));
}

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await installUserTokenFixture();
});

beforeEach(() => {
  resetClientCache();
  resetAuthorizationCleanup();
  rows = new Map();
  db = new FakeDsql();
  db.on(/insert into "delegation"\."authorizations"/, (q) => {
    const row = inserted(q);
    rows.set(row.id as string, row);
    return [];
  });
  db.on(/select .* from "delegation"\."authorizations" where "id" = \$1/, (q) => {
    const row = rows.get(q.values[0] as string);
    return row ? [row] : [];
  });
  db.on(/update "delegation"\."authorizations"/, (q) => {
    const id = q.values[5] as string;
    const row = rows.get(id);
    if (!row || row.code_hash !== null) return [];
    Object.assign(row, {
      mode: q.values[0],
      days: q.values[1],
      code_hash: q.values[2],
      code_expires_at_ms: q.values[3],
      expires_at_ms: q.values[4],
    });
    return [row];
  });
  db.on(/delete from "delegation"\."authorizations" where "id" = \$1/, (q) => {
    const row = rows.get(q.values[0] as string);
    rows.delete(q.values[0] as string);
    return row ? [row] : [];
  });
  db.on(/delete from "delegation"\."authorizations" where "expires_at_ms" <=/, []);
  cognitoCalls = [];
  groups = ["starkeep-users"];
  clientDoc = () => ({
    status: 200,
    cacheControl: "max-age=600",
    body: JSON.stringify({
      client_id: CLIENT,
      client_name: "Example Assistant",
      redirect_uris: [REDIRECT, "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
    }),
  });
});

/** Run the authorize request and the sign-in; answer the consent page. */
async function toConsent(query = authorizeQuery()) {
  const start = await handleConnectRoute(req({ query }), deps());
  expect(start.statusCode).toBe(302);
  const cookies = jar(start);
  const state = new URL(start.headers.Location!).searchParams.get("state")!;
  const page = await handleConnectRoute(
    req({ rawPath: "/connect/callback", query: { state, code: "c1" }, cookieHeader: cookies }),
    deps(),
  );
  return { start, page, cookies: jar(page, cookies) };
}

async function answer(
  consent: { page: ConnectResponse; cookies: string },
  form: Record<string, string>,
) {
  const csrf = /name="csrf" value="([^"]+)"/.exec(consent.page.body)![1]!;
  const authorization = /name="authorization" value="([^"]+)"/.exec(consent.page.body)![1]!;
  return handleConnectRoute(
    req({
      method: "POST",
      rawPath: "/connect/authorize/approve",
      headers: { "sec-fetch-site": "same-origin" },
      cookieHeader: consent.cookies,
      body: new URLSearchParams({ csrf, authorization, ...form }).toString(),
    }),
    deps(),
  );
}

describe("the authorization request", () => {
  it("sends a valid request to managed login on the connectors client", async () => {
    const res = await handleConnectRoute(req({ query: authorizeQuery() }), deps());
    expect(res.statusCode).toBe(302);
    const to = new URL(res.headers.Location!);
    expect(to.host).toBe(COGNITO);
    expect(to.searchParams.get("client_id")).toBe(CONNECTORS);
    expect(to.searchParams.get("redirect_uri")).toBe(`${ISSUER}/connect/callback`);
  });

  it.each([
    ["no client_id", { client_id: undefined }],
    ["an http client_id", { client_id: "http://client.example/oauth/metadata.json" }],
    ["no redirect_uri", { redirect_uri: undefined }],
    ["an unlisted redirect_uri", { redirect_uri: "https://evil.example/callback" }],
  ])("renders an error page and never redirects for %s", async (_label, over) => {
    const res = await handleConnectRoute(req({ query: authorizeQuery(over) }), deps());
    expect(res.statusCode).toBe(400);
    expect(res.headers.Location).toBeUndefined();
  });

  it("renders an error page when the client's document does not load", async () => {
    clientDoc = () => ({ status: 404, cacheControl: undefined, body: "" });
    const res = await handleConnectRoute(req({ query: authorizeQuery() }), deps());
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("client.example");
  });

  it.each([
    ["unsupported_response_type", { response_type: "token" }],
    ["unsupported_response_type", { response_type: undefined }],
    ["invalid_request", { code_challenge_method: "plain" }],
    ["invalid_request", { code_challenge_method: undefined }],
    ["invalid_request", { code_challenge: undefined }],
    ["invalid_request", { code_challenge: "short" }],
    ["invalid_scope", { scope: "admin" }],
    ["invalid_target", { resource: undefined }],
    ["invalid_target", { resource: "https://evil.example/apps/probe/mcp" }],
    ["invalid_target", { resource: "https://cloud.example.com/apps/probe/api/echo" }],
    ["invalid_target", { resource: "https://cloud.example.com/apps/photos/mcp" }],
  ])("redirects %s with state and iss", async (error, over) => {
    const res = await handleConnectRoute(req({ query: authorizeQuery(over) }), deps());
    expect(res.statusCode).toBe(302);
    const to = new URL(res.headers.Location!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("error")).toBe(error);
    expect(to.searchParams.get("state")).toBe("client-state");
    expect(to.searchParams.get("iss")).toBe(ISSUER);
  });

  it("accepts a loopback redirect on any port", async () => {
    const res = await handleConnectRoute(
      req({ query: authorizeQuery({ redirect_uri: "http://127.0.0.1:53124/callback" }) }),
      deps(),
    );
    expect(new URL(res.headers.Location!).host).toBe(COGNITO);
  });

  it("accepts the deployment's other host name as the resource", async () => {
    const res = await handleConnectRoute(
      req({ query: authorizeQuery({ resource: "https://d111.cloudfront.net/apps/probe/mcp" }) }),
      deps(),
    );
    expect(new URL(res.headers.Location!).host).toBe(COGNITO);
  });
});

describe("the consent page", () => {
  it("stores the request with its sealed refresh token and names the account", async () => {
    const { page } = await toConsent();
    expect(page.statusCode).toBe(200);
    const [row] = [...rows.values()];
    expect(row).toMatchObject({
      user_id: TEST_USER_ID,
      user_email: "ada@example.com",
      app_id: "probe",
      resource: RESOURCE,
      client_id: CLIENT,
      client_name: "Example Assistant",
      redirect_uri: REDIRECT,
      state: "client-state",
      code_challenge: CHALLENGE,
      requested_scope: "read",
      mode: null,
      code_hash: null,
    });
    expect(
      openRefreshToken(
        key.refreshKey,
        row!.id as string,
        row!.cognito_refresh_ciphertext as string,
      ),
    ).toBe("refresh-for-c1");
    expect(page.body).toContain("ada@example.com");
    expect(page.body).toContain("Example Assistant");
    expect(page.body).toContain("<code>client.example</code>");
    expect(page.body).toContain("Probe");
    expect(page.body).toMatch(/value="read" checked/);
    expect(page.body).toMatch(/<option value="90" selected>/);
    expect(page.body).not.toContain("this computer");
  });

  it("lets the redirect's origin, and no other, receive the approval", async () => {
    const { page } = await toConsent();
    const csp = page.headers["Content-Security-Policy"]!;
    expect(csp).toContain(`form-action 'self' https://${COGNITO} https://client.example;`);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("names the loopback origin with its port, and warns", async () => {
    const { page } = await toConsent(
      authorizeQuery({ redirect_uri: "http://127.0.0.1:53124/callback" }),
    );
    expect(page.headers["Content-Security-Policy"]).toContain("http://127.0.0.1:53124;");
    expect(page.body).toContain("this computer");
    expect(page.body).toContain("Any program");
  });

  it("preselects read and write only when the client asks for it", async () => {
    const { page } = await toConsent(authorizeQuery({ scope: "read readwrite" }));
    expect(page.body).toMatch(/value="readwrite" checked/);
  });

  it("refuses an account with no data library and ends its refresh token", async () => {
    groups = [];
    const { page } = await toConsent();
    expect(page.statusCode).toBe(403);
    expect(rows.size).toBe(0);
    expect(cognitoCalls.some((c) => c.url.endsWith("/oauth2/revoke"))).toBe(true);
  });

  it("checks the request again at the callback: an app uninstalled meanwhile", async () => {
    const start = await handleConnectRoute(req({ query: authorizeQuery() }), deps());
    const state = new URL(start.headers.Location!).searchParams.get("state")!;
    const res = await handleConnectRoute(
      req({ rawPath: "/connect/callback", query: { state, code: "c1" }, cookieHeader: jar(start) }),
      { ...deps(), connectableApps: async () => [] },
    );
    expect(new URL(res.headers.Location!).searchParams.get("error")).toBe("invalid_target");
    expect(rows.size).toBe(0);
    expect(cognitoCalls.some((c) => c.url.endsWith("/oauth2/revoke"))).toBe(true);
  });
});

describe("the approval", () => {
  it("stores the code's hash, the mode and the expiry, and redirects with code, state and iss", async () => {
    const consent = await toConsent();
    const res = await answer(consent, { decision: "approve", mode: "readwrite", days: "30" });
    expect(res.statusCode).toBe(303);
    const to = new URL(res.headers.Location!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("client-state");
    expect(to.searchParams.get("iss")).toBe(ISSUER);
    const code = to.searchParams.get("code")!;
    const [row] = [...rows.values()];
    expect(row).toMatchObject({ mode: "readwrite", days: 30, code_hash: hashCode(code) });
    // The code itself is never stored.
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it("answers once: a second approval of the same page issues nothing", async () => {
    const consent = await toConsent();
    await answer(consent, { decision: "approve", mode: "read", days: "90" });
    const again = await answer(consent, { decision: "approve", mode: "read", days: "90" });
    expect(again.statusCode).toBe(400);
    expect(again.headers.Location).toBeUndefined();
  });

  it("deletes the row, revokes the refresh token and redirects access_denied on a denial", async () => {
    const consent = await toConsent();
    const res = await answer(consent, { decision: "deny" });
    const to = new URL(res.headers.Location!);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("client-state");
    expect(rows.size).toBe(0);
    const revoke = cognitoCalls.find((c) => c.url.endsWith("/oauth2/revoke"));
    expect(revoke?.body.get("token")).toBe("refresh-for-c1");
  });

  it("refuses a cross-site post", async () => {
    const consent = await toConsent();
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.page.body)![1]!;
    const res = await handleConnectRoute(
      req({
        method: "POST",
        rawPath: "/connect/authorize/approve",
        headers: { "sec-fetch-site": "cross-site" },
        cookieHeader: consent.cookies,
        body: `csrf=${csrf}&decision=approve&mode=read&days=90`,
      }),
      deps(),
    );
    expect(res.statusCode).toBe(403);
  });

  it("refuses a form whose authorization is not the one this browser signed in for", async () => {
    const consent = await toConsent();
    const res = await answer(
      { ...consent, cookies: consent.cookies.replace(/sk_oauth_authz=[^;]+/, "sk_oauth_authz=x") },
      { decision: "approve", mode: "read", days: "90" },
    );
    expect(res.statusCode).toBe(400);
    expect([...rows.values()][0]!.code_hash).toBeNull();
  });

  it("refuses an odd mode or expiry", async () => {
    const consent = await toConsent();
    expect(
      (await answer(consent, { decision: "approve", mode: "admin", days: "90" })).statusCode,
    ).toBe(400);
    expect(
      (await answer(consent, { decision: "approve", mode: "read", days: "5" })).statusCode,
    ).toBe(400);
  });
});

describe("cleanup", () => {
  it("deletes expired rows on an authorize call and revokes the unclaimed ones' refresh tokens", async () => {
    const sealed = (id: string) => sealRefreshToken(key.refreshKey, id, `stale-${id}`);
    const expired = [
      { id: "a", used_at_ms: null, cognito_refresh_ciphertext: sealed("a") },
      { id: "b", used_at_ms: 5, cognito_refresh_ciphertext: sealed("b") },
    ];
    db = new FakeDsql();
    db.on(/delete from "delegation"\."authorizations" where "expires_at_ms" <=/, () =>
      expired.map((r) => ({ ...r, created_at_ms: 0, expires_at_ms: 0 })),
    );
    await handleConnectRoute(req({ query: authorizeQuery() }), deps());
    await handleConnectRoute(req({ query: authorizeQuery() }), deps());
    // Once a minute, not on every call.
    expect(db.calls(/delete from "delegation"\."authorizations"/)).toHaveLength(1);
    const revoked = cognitoCalls
      .filter((c) => c.url.endsWith("/oauth2/revoke"))
      .map((c) => c.body.get("token"));
    // A row a code exchange claimed handed its token to a grant: left alone.
    expect(revoked).toEqual(["stale-a"]);
  });
});
