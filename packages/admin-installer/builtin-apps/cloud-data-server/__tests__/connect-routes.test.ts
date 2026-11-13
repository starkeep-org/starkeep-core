/**
 * The consent and connections pages, end to end against a fake Cognito and a
 * scripted database: a consent signs in, creates one row with its own sealed
 * refresh token, and shows a token that verifies; the list signs in, shows
 * the rows, and revokes one at the database and at Cognito.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleConnectRoute,
  isConnectRoute,
  sameOriginPost,
  type ConnectDeps,
  type ConnectRequest,
  type ConnectResponse,
} from "../src/connect-routes.js";
import {
  delegationSigningKeyFromPem,
  openRefreshToken,
  verifyDelegationToken,
} from "../src/delegation-tokens.js";
import { FakeDsql } from "./fake-dsql.js";
import { makeDelegationKeyPem } from "./delegation-key.js";
import {
  installUserTokenFixture,
  mintTestUserToken,
  TEST_POOL_ID,
  TEST_REGION,
  TEST_USER_ID,
} from "./user-token.js";

const HOST = "abc123.execute-api.us-east-1.amazonaws.com";
const COGNITO = "teststack.auth.us-east-1.amazoncognito.com";
const CONNECTORS = "test-connectors-client";
const key = delegationSigningKeyFromPem(makeDelegationKeyPem().privateKeyPem);

let db: FakeDsql;
let cognitoCalls: { url: string; body: URLSearchParams }[];
let groups: string[];

function deps(): ConnectDeps {
  return {
    pool: { region: TEST_REGION, userPoolId: TEST_POOL_ID, userPoolClientId: CONNECTORS },
    cognitoDomain: COGNITO,
    host: HOST,
    signingKey: async () => key,
    db: async () => db.createClient({ hostname: "x", region: "x" }),
    connectableApps: async () => [{ appId: "probe", name: "Probe" }],
    groupsMayUseData: (g) => g.includes("starkeep-users"),
    fetch: async (input, init) => {
      const url = String(input);
      const body = new URLSearchParams(String(init?.body ?? ""));
      cognitoCalls.push({ url, body });
      if (url.endsWith("/oauth2/token")) {
        return new Response(
          JSON.stringify({
            id_token: await mintTestUserToken({ aud: CONNECTORS, "cognito:groups": groups }),
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
    rawPath: "/connect",
    query: {},
    headers: {},
    cookieHeader: undefined,
    body: "",
    ...over,
  };
}

/** Cookie name=value pairs a response sets, for the next request. */
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
    const value = pair.slice(pair.indexOf("=") + 1);
    if (/Max-Age=0/.test(c)) delete set[name];
    else set[name] = value;
  }
  return Object.entries(set)
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");
}

function csrfOf(res: ConnectResponse): string {
  return /name="csrf" value="([^"]+)"/.exec(res.body)![1]!;
}

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await installUserTokenFixture();
});

beforeEach(() => {
  db = new FakeDsql();
  db.on(/insert into "delegation"\."grants"/, []);
  cognitoCalls = [];
  groups = ["starkeep-users"];
});

async function consent(form: Record<string, string>) {
  const page = await handleConnectRoute(
    req({ query: { app: "probe", client: "Claude Code" } }),
    deps(),
  );
  let cookies = jar(page);
  const approve = await handleConnectRoute(
    req({
      method: "POST",
      rawPath: "/connect/approve",
      headers: { "sec-fetch-site": "same-origin" },
      cookieHeader: cookies,
      body: new URLSearchParams({ csrf: csrfOf(page), ...form }).toString(),
    }),
    deps(),
  );
  cookies = jar(approve, cookies);
  return { page, approve, cookies };
}

describe("the consent flow", () => {
  it("defaults to read and 90 days, and keeps the page out of frames", async () => {
    const page = await handleConnectRoute(req({ query: { app: "probe" } }), deps());
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/value="read" checked/);
    expect(page.body).toMatch(/<option value="90" selected>/);
    expect(page.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("signs in through the connectors client, with PKCE", async () => {
    const { approve } = await consent({
      client: "Claude Code",
      app: "probe",
      mode: "read",
      days: "90",
    });
    expect(approve.statusCode).toBe(302);
    const to = new URL(approve.headers.Location!);
    expect(to.host).toBe(COGNITO);
    expect(to.searchParams.get("client_id")).toBe(CONNECTORS);
    expect(to.searchParams.get("redirect_uri")).toBe(`https://${HOST}/connect/callback`);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("creates one row with its own sealed refresh token and shows a token once", async () => {
    const { approve, cookies } = await consent({
      client: "Claude Code",
      app: "probe",
      mode: "readwrite",
      days: "30",
    });
    const state = new URL(approve.headers.Location!).searchParams.get("state")!;
    const done = await handleConnectRoute(
      req({ rawPath: "/connect/callback", query: { state, code: "c1" }, cookieHeader: cookies }),
      deps(),
    );
    expect(done.statusCode).toBe(200);
    const insert = db.calls(/insert into "delegation"\."grants"/);
    expect(insert).toHaveLength(1);
    const values = insert[0]!.values;
    expect(values).toContain(TEST_USER_ID);
    expect(values).toContain("readwrite");
    // The refresh token is stored sealed, never in the clear.
    expect(values).not.toContain("refresh-for-c1");
    const id = values[0] as string;
    const sealed = values.find((v) => typeof v === "string" && v.length > 40 && v !== id) as string;
    expect(openRefreshToken(key.refreshKey, id, sealed)).toBe("refresh-for-c1");

    const shown = /<textarea readonly>([^<]+)<\/textarea>/.exec(done.body)![1]!;
    expect(verifyDelegationToken(shown, key)).toMatchObject({
      sub: TEST_USER_ID,
      aud: "probe",
      sk_dlg: id,
      sk_mode: "readwrite",
      sk_channel: "app",
    });
    // The pending cookie is cleared, so a reload cannot mint a second token.
    expect(jar(done, cookies)).not.toContain("sk_connect=");
  });

  it("refuses a cross-site form post", async () => {
    const page = await handleConnectRoute(req({}), deps());
    const res = await handleConnectRoute(
      req({
        method: "POST",
        rawPath: "/connect/approve",
        headers: { "sec-fetch-site": "cross-site" },
        cookieHeader: jar(page),
        body: new URLSearchParams({
          csrf: csrfOf(page),
          client: "x",
          app: "probe",
          mode: "read",
          days: "90",
        }).toString(),
      }),
      deps(),
    );
    expect(res.statusCode).toBe(403);
  });

  it("refuses a post without the page's CSRF token", async () => {
    const res = await handleConnectRoute(
      req({
        method: "POST",
        rawPath: "/connect/approve",
        headers: { "sec-fetch-site": "same-origin" },
        body: "client=x&app=probe&mode=read&days=90&csrf=guess",
      }),
      deps(),
    );
    expect(res.statusCode).toBe(403);
  });

  it("refuses an app that serves no outside clients, and an odd expiry", async () => {
    expect(
      (await consent({ client: "x", app: "photos", mode: "read", days: "90" })).approve.statusCode,
    ).toBe(404);
    expect(
      (await consent({ client: "x", app: "probe", mode: "read", days: "10000" })).approve
        .statusCode,
    ).toBe(400);
  });

  it("refuses a callback whose state does not match, and creates nothing", async () => {
    const { cookies } = await consent({ client: "x", app: "probe", mode: "read", days: "90" });
    const res = await handleConnectRoute(
      req({
        rawPath: "/connect/callback",
        query: { state: "other", code: "c1" },
        cookieHeader: cookies,
      }),
      deps(),
    );
    expect(res.statusCode).toBe(400);
    expect(db.calls(/insert/)).toHaveLength(0);
  });

  it("refuses an account with no data library and ends its refresh token", async () => {
    groups = [];
    const { approve, cookies } = await consent({
      client: "x",
      app: "probe",
      mode: "read",
      days: "90",
    });
    const state = new URL(approve.headers.Location!).searchParams.get("state")!;
    const res = await handleConnectRoute(
      req({ rawPath: "/connect/callback", query: { state, code: "c1" }, cookieHeader: cookies }),
      deps(),
    );
    expect(res.statusCode).toBe(403);
    expect(db.calls(/insert/)).toHaveLength(0);
    expect(cognitoCalls.some((c) => c.url.endsWith("/oauth2/revoke"))).toBe(true);
  });
});

describe("the connections list", () => {
  async function signedIn(): Promise<string> {
    const start = await handleConnectRoute(req({ rawPath: "/connections" }), deps());
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.Location!).searchParams.get("state")!;
    const back = await handleConnectRoute(
      req({ rawPath: "/connect/callback", query: { state, code: "c9" }, cookieHeader: jar(start) }),
      deps(),
    );
    expect(back.statusCode).toBe(302);
    expect(back.headers.Location).toBe("/connections");
    // The list needs no refresh token, so the one it got ends at once.
    expect(cognitoCalls.filter((c) => c.url.endsWith("/oauth2/revoke"))).toHaveLength(1);
    return jar(back, jar(start));
  }

  it("lists the user's rows and revokes one at the database and at Cognito", async () => {
    const cookies = await signedIn();
    const live = {
      id: "dlg-1",
      user_id: TEST_USER_ID,
      app_id: "probe",
      channel: "app",
      mode: "read",
      client_name: "Claude <Code>",
      cognito_refresh_ciphertext: (await import("../src/delegation-tokens.js")).sealRefreshToken(
        key.refreshKey,
        "dlg-1",
        "refresh-dlg-1",
      ),
      created_at_ms: String(Date.now()),
      expires_at_ms: String(Date.now() + 86_400_000),
      revoked_at_ms: null,
      last_used_at_ms: null,
      last_write_at_ms: null,
    };
    db.on(/select .* from "delegation"\."grants" where "user_id"/, [live]);
    db.on(/update "delegation"\."grants"/, [{ ...live, revoked_at_ms: String(Date.now()) }]);

    const list = await handleConnectRoute(
      req({ rawPath: "/connections", cookieHeader: cookies }),
      deps(),
    );
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain("Claude &lt;Code&gt;");
    expect(list.body).toContain('action="/connections/dlg-1/revoke"');

    const revoked = await handleConnectRoute(
      req({
        method: "POST",
        rawPath: "/connections/dlg-1/revoke",
        headers: { "sec-fetch-site": "same-origin" },
        cookieHeader: jar(list, cookies),
        body: `csrf=${csrfOf(list)}`,
      }),
      deps(),
    );
    expect(revoked.statusCode).toBe(302);
    const update = db.calls(/update "delegation"\."grants"/)[0]!;
    expect(update.values).toContain(TEST_USER_ID);
    const revokes = cognitoCalls.filter((c) => c.url.endsWith("/oauth2/revoke"));
    expect(revokes.at(-1)!.body.get("token")).toBe("refresh-dlg-1");
  });
});

describe("helpers", () => {
  it("names only the six routes", () => {
    expect(isConnectRoute("GET", "/connect")).toBe(true);
    expect(isConnectRoute("POST", "/connections/abc/revoke")).toBe(true);
    expect(isConnectRoute("GET", "/connections/abc/revoke")).toBe(false);
    expect(isConnectRoute("DELETE", "/connect")).toBe(false);
  });

  it("treats a missing Sec-Fetch-Site as same-origin only with a matching Origin", () => {
    expect(sameOriginPost({ origin: `https://${HOST}` }, HOST)).toBe(true);
    expect(sameOriginPost({ origin: "https://evil.example" }, HOST)).toBe(false);
    expect(sameOriginPost({}, HOST)).toBe(false);
  });
});
