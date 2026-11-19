/**
 * The OAuth flow against one real Postgres: authorize, sign in, consent,
 * exchange the code, refresh, and revoke.
 *
 * The routes run through `handleConnectRoute` with PGlite behind `db()`, so
 * every store query the flow issues runs as SQL. Cognito and the client's
 * metadata document are scripted.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  handleConnectRoute,
  type ConnectDeps,
  type ConnectRequest,
  type ConnectResponse,
} from "../../src/connect-routes.js";
import {
  delegationSigningKeyFromPem,
  hashRefreshToken,
  verifyDelegationToken,
} from "../../src/delegation-tokens.js";
import {
  findDelegation,
  listDelegations,
  type ConnectableApp,
} from "../../src/delegation-store.js";
import { resetUserCheckCache } from "../../src/delegation-user-check.js";
import { resetAuthorizationCleanup } from "../../src/oauth-authorize.js";
import { resetClientCache } from "../../src/oauth-clients.js";
import { ROTATION_GRACE_MS } from "../../src/oauth-token.js";
import {
  installUserTokenFixture,
  mintTestUserToken,
  TEST_POOL_ID,
  TEST_REGION,
  TEST_USER_ID,
} from "../user-token.js";
import { makeDelegationKeyPem } from "../delegation-key.js";
import { createSharedSchema } from "../../../../../storage-aurora-dsql/__tests__/pg-shared-schema.js";
import { dropAllUserSchemas } from "../../../../../storage-aurora-dsql/__tests__/pglite-reset.js";

const HOST = "abc123.execute-api.us-east-1.amazonaws.com";
const COGNITO = "teststack.auth.us-east-1.amazoncognito.com";
const CONNECTORS = "test-connectors-client";
const CLIENT = "https://client.example/oauth/metadata.json";
const OTHER_CLIENT = "https://other.example/oauth/metadata.json";
const REDIRECT = "http://127.0.0.1:53124/callback";
const RESOURCE = "https://cloud.example.com/apps/probe/mcp";
const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const key = delegationSigningKeyFromPem(makeDelegationKeyPem().privateKeyPem);

let pg: PGlite;
let client: DatabaseClient;
let now: number;
/** What Cognito's token endpoint answers to a refresh-token grant. */
let cognitoRefresh: "ok" | "refused" | "unavailable";
let revoked: string[];
/** The installed apps that serve outside clients. */
let apps: ConnectableApp[];
/** When set, the next SQL statement that matches fails once. */
let failNext: RegExp | null;
/** When set, runs once just before the next SQL statement that matches. */
let beforeNext: { pattern: RegExp; run: () => Promise<void> } | null;

function deps(): ConnectDeps {
  return {
    pool: { region: TEST_REGION, userPoolId: TEST_POOL_ID, userPoolClientId: CONNECTORS },
    cognitoDomain: COGNITO,
    host: HOST,
    signingKey: async () => key,
    db: async () => client,
    connectableApps: async () => apps,
    viewerHosts: async () => ["cloud.example.com"],
    publicHost: async () => "cloud.example.com",
    groupsMayUseData: (g) => g.includes("starkeep-users"),
    forgetDelegation: () => {},
    now: () => now,
    clients: {
      now: () => now,
      fetchDocument: async (url) => ({
        status: 200,
        cacheControl: undefined,
        body: JSON.stringify({
          client_id: url.href,
          client_name: "Example Assistant",
          redirect_uris: ["http://127.0.0.1/callback"],
        }),
      }),
    },
    fetch: async (input, init) => {
      const url = String(input);
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (url.endsWith("/oauth2/revoke")) {
        revoked.push(body.get("token")!);
        return new Response("", { status: 200 });
      }
      if (body.get("grant_type") === "refresh_token" && cognitoRefresh === "refused") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      if (body.get("grant_type") === "refresh_token" && cognitoRefresh === "unavailable") {
        return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
      }
      return new Response(
        JSON.stringify({
          id_token: await mintTestUserToken({
            aud: CONNECTORS,
            "cognito:groups": ["starkeep-users"],
            email: "ada@example.com",
          }),
          refresh_token: `cognito-refresh-${body.get("code")}`,
        }),
        { status: 200 },
      );
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

/** Authorize, sign in and approve; answer the code. */
async function approvedCode(mode = "read", clientId = CLIENT): Promise<string> {
  const start = await handleConnectRoute(
    req({
      query: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: "code",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        resource: RESOURCE,
        scope: "read",
        state: "s1",
      },
    }),
    deps(),
  );
  let cookies = jar(start);
  const state = new URL(start.headers.Location!).searchParams.get("state")!;
  const page = await handleConnectRoute(
    req({ rawPath: "/connect/callback", query: { state, code: "c1" }, cookieHeader: cookies }),
    deps(),
  );
  cookies = jar(page, cookies);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
  const authorization = /name="authorization" value="([^"]+)"/.exec(page.body)![1]!;
  const approved = await handleConnectRoute(
    req({
      method: "POST",
      rawPath: "/connect/authorize/approve",
      headers: { "sec-fetch-site": "same-origin" },
      cookieHeader: cookies,
      body: new URLSearchParams({
        csrf,
        authorization,
        decision: "approve",
        mode,
        days: "30",
      }).toString(),
    }),
    deps(),
  );
  return new URL(approved.headers.Location!).searchParams.get("code")!;
}

async function token(form: Record<string, string>) {
  const res = await handleConnectRoute(
    req({ method: "POST", rawPath: "/connect/token", body: new URLSearchParams(form).toString() }),
    deps(),
  );
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

function exchange(code: string, over: Record<string, string> = {}) {
  return token({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...over,
  });
}

function refresh(refreshToken: string, over: Record<string, string> = {}) {
  return token({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT,
    ...over,
  });
}

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await installUserTokenFixture();
  pg = new PGlite();
  await pg.waitReady;
  client = {
    async query(text, values) {
      if (failNext?.test(text)) {
        failNext = null;
        throw new Error("simulated database failure");
      }
      if (beforeNext?.pattern.test(text)) {
        const { run } = beforeNext;
        beforeNext = null;
        await run();
      }
      const result = await pg.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    async end() {},
  };
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await dropAllUserSchemas(pg);
  await createSharedSchema(pg);
  resetClientCache();
  resetAuthorizationCleanup();
  resetUserCheckCache();
  now = Date.now();
  cognitoRefresh = "ok";
  revoked = [];
  apps = [{ appId: "probe", name: "Probe", delegatedPaths: ["/mcp"] }];
  failNext = null;
  beforeNext = null;
});

describe("the code exchange", () => {
  it("creates the delegation under the authorization's id and answers both tokens", async () => {
    const res = await exchange(await approvedCode("readwrite"));
    expect(res.status).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "readwrite" });
    expect(res.body.refresh_token).toMatch(/^skr_/);
    const claims = verifyDelegationToken(res.body.access_token, key, now)!;
    expect(claims).toMatchObject({ sub: TEST_USER_ID, aud: "probe", sk_mode: "readwrite" });
    expect(claims.exp - claims.iat).toBe(900);

    const [grant] = await listDelegations(client, TEST_USER_ID);
    expect(grant).toMatchObject({
      id: claims.sk_dlg,
      app_id: "probe",
      mode: "readwrite",
      client_name: "Example Assistant",
      client_id: CLIENT,
      redirect_host: "127.0.0.1:53124",
    });
    expect(grant!.expires_at_ms).toBe(now + 30 * 24 * 60 * 60 * 1000);
    // The refresh token is stored as a hash only.
    const stored = await pg.query<{ token_hash: string }>(
      "SELECT token_hash FROM delegation.refresh_tokens",
    );
    expect(stored.rows).toEqual([{ token_hash: hashRefreshToken(res.body.refresh_token) }]);
  });

  it.each([
    ["a wrong PKCE verifier", { code_verifier: "w".repeat(43) }, "invalid_grant"],
    ["a missing verifier", { code_verifier: "" }, "invalid_grant"],
    ["another client", { client_id: OTHER_CLIENT }, "invalid_grant"],
    ["another redirect URI", { redirect_uri: "http://127.0.0.1:1/callback" }, "invalid_grant"],
    ["another resource", { resource: "https://cloud.example.com/apps/x/mcp" }, "invalid_target"],
  ])("refuses %s and creates nothing", async (_label, over, error) => {
    const res = await exchange(await approvedCode(), over);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(await listDelegations(client, TEST_USER_ID)).toEqual([]);
  });

  it("refuses an unknown code", async () => {
    expect((await exchange("nope")).body.error).toBe("invalid_grant");
  });

  it("refuses an expired code", async () => {
    const code = await approvedCode();
    now += 61_000;
    expect((await exchange(code)).body.error).toBe("invalid_grant");
  });

  it("refuses a second use of a code and revokes what the first made", async () => {
    const code = await approvedCode();
    const first = await exchange(code);
    expect(first.status).toBe(200);
    const second = await exchange(code);
    expect(second.body.error).toBe("invalid_grant");
    const [grant] = await listDelegations(client, TEST_USER_ID);
    expect(grant!.revoked_at_ms).not.toBeNull();
    expect(revoked).toEqual(["cognito-refresh-c1"]);
    expect((await refresh(first.body.refresh_token)).body.error).toBe("invalid_grant");
  });

  it("refuses a code for an app uninstalled since the consent, and creates nothing", async () => {
    const code = await approvedCode();
    apps = [];
    const res = await exchange(code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(await listDelegations(client, TEST_USER_ID)).toEqual([]);
  });

  it("refuses an unsupported grant type", async () => {
    expect((await token({ grant_type: "password" })).body.error).toBe("unsupported_grant_type");
  });
});

describe("the refresh", () => {
  it("rotates the refresh token and issues a new access token", async () => {
    const first = await exchange(await approvedCode());
    now += 10 * 60_000;
    const second = await refresh(first.body.refresh_token, { resource: RESOURCE });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    expect(verifyDelegationToken(second.body.access_token, key, now)?.sk_mode).toBe("read");
    const third = await refresh(second.body.refresh_token);
    expect(third.status).toBe(200);
  });

  it("only refuses a rotated token inside the grace window", async () => {
    const first = await exchange(await approvedCode());
    const second = await refresh(first.body.refresh_token);
    now += ROTATION_GRACE_MS - 1000;
    expect((await refresh(first.body.refresh_token)).body.error).toBe("invalid_grant");
    // The newer token still works: the repeat looked like a concurrent refresh.
    expect((await refresh(second.body.refresh_token)).status).toBe(200);
  });

  it("revokes the delegation when a rotated token comes back after the grace window", async () => {
    const first = await exchange(await approvedCode());
    const second = await refresh(first.body.refresh_token);
    now += ROTATION_GRACE_MS + 1000;
    expect((await refresh(first.body.refresh_token)).body.error).toBe("invalid_grant");
    expect((await refresh(second.body.refresh_token)).body.error).toBe("invalid_grant");
    const [grant] = await listDelegations(client, TEST_USER_ID);
    expect(grant!.revoked_at_ms).not.toBeNull();
    expect(revoked).toEqual(["cognito-refresh-c1"]);
  });

  it("keeps the presented token usable when issuing its successor fails", async () => {
    const first = await exchange(await approvedCode());
    failNext = /insert into "delegation"\."refresh_tokens"/i;
    const failed = await refresh(first.body.refresh_token);
    expect(failed.status).toBe(503);
    expect(failNext).toBeNull();
    // Long after the failure, the same token still refreshes: nothing rotated it.
    now += ROTATION_GRACE_MS + 1000;
    const retried = await refresh(first.body.refresh_token);
    expect(retried.status).toBe(200);
    const [grant] = await listDelegations(client, TEST_USER_ID);
    expect(grant!.revoked_at_ms).toBeNull();
  });

  it("withdraws the successor when a concurrent refresh rotates the token first", async () => {
    const first = await exchange(await approvedCode());
    const presented = hashRefreshToken(first.body.refresh_token);
    beforeNext = {
      pattern: /update "delegation"\."refresh_tokens"/i,
      run: async () => {
        await pg.query(
          "UPDATE delegation.refresh_tokens SET rotated_at_ms = $1 WHERE token_hash = $2",
          [now, presented],
        );
      },
    };
    const lost = await refresh(first.body.refresh_token);
    expect(lost.body.error).toBe("invalid_grant");
    expect(beforeNext).toBeNull();
    // Only the presented token remains: the losing refresh left no successor.
    const stored = await pg.query<{ token_hash: string }>(
      "SELECT token_hash FROM delegation.refresh_tokens",
    );
    expect(stored.rows).toEqual([{ token_hash: presented }]);
  });

  it("refuses another client's refresh", async () => {
    const first = await exchange(await approvedCode());
    expect((await refresh(first.body.refresh_token, { client_id: OTHER_CLIENT })).body.error).toBe(
      "invalid_grant",
    );
  });

  it("refuses a resource for another app", async () => {
    const first = await exchange(await approvedCode());
    const res = await refresh(first.body.refresh_token, {
      resource: "https://cloud.example.com/apps/photos/mcp",
    });
    expect(res.body.error).toBe("invalid_target");
  });

  it("ends the delegation when Cognito refuses the user", async () => {
    const first = await exchange(await approvedCode());
    cognitoRefresh = "refused";
    expect((await refresh(first.body.refresh_token)).body.error).toBe("invalid_grant");
    const [grant] = await listDelegations(client, TEST_USER_ID);
    expect(grant!.revoked_at_ms).not.toBeNull();
  });

  it("answers 503 when Cognito does not answer, and neither revokes nor rotates", async () => {
    const first = await exchange(await approvedCode());
    resetUserCheckCache();
    cognitoRefresh = "unavailable";
    const res = await refresh(first.body.refresh_token);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("temporarily_unavailable");
    const [grant] = await listDelegations(client, TEST_USER_ID);
    expect(grant!.revoked_at_ms).toBeNull();
    expect(revoked).toEqual([]);
    // The same refresh token works once Cognito answers again.
    cognitoRefresh = "ok";
    expect((await refresh(first.body.refresh_token)).status).toBe(200);
  });

  it("refuses a refresh after the delegation's expiry", async () => {
    const first = await exchange(await approvedCode());
    now += 31 * 24 * 60 * 60 * 1000;
    expect((await refresh(first.body.refresh_token)).body.error).toBe("invalid_grant");
  });

  it("ends every refresh token when the user revokes on the connections page", async () => {
    const first = await exchange(await approvedCode());
    const claims = verifyDelegationToken(first.body.access_token, key, now)!;
    const session = await mintTestUserToken({
      aud: CONNECTORS,
      "cognito:groups": ["starkeep-users"],
    });
    const csrf = "c".repeat(32);
    const res = await handleConnectRoute(
      req({
        method: "POST",
        rawPath: `/connections/${claims.sk_dlg}/revoke`,
        headers: { "sec-fetch-site": "same-origin" },
        cookieHeader: `sk_connections=${session}; sk_connect_csrf=${csrf}`,
        body: `csrf=${csrf}`,
      }),
      deps(),
    );
    expect(res.statusCode).toBe(302);
    expect((await findDelegation(client, claims.sk_dlg))!.revoked_at_ms).not.toBeNull();
    const live = await pg.query(
      "SELECT 1 FROM delegation.refresh_tokens WHERE rotated_at_ms IS NULL",
    );
    expect(live.rows).toEqual([]);
    expect((await refresh(first.body.refresh_token)).body.error).toBe("invalid_grant");
  });
});

describe("cleanup", () => {
  it("deletes expired authorizations and keeps a claimed one's refresh token", async () => {
    await exchange(await approvedCode());
    // An authorization that never finished. Its ciphertext opens to nothing,
    // so the unit test covers the revoke; this one checks the SQL.
    await pg.exec(`
      INSERT INTO delegation.authorizations
        (id, user_id, user_email, app_id, resource, client_id, client_name, redirect_uri,
         code_challenge, requested_scope, cognito_refresh_ciphertext, created_at_ms, expires_at_ms)
      VALUES ('stale', 'u', '', 'probe', '${RESOURCE}', '${CLIENT}', '', '${REDIRECT}',
         '${CHALLENGE}', 'read', 'x', 0, 1)
    `);
    now += 11 * 60_000;
    resetAuthorizationCleanup();
    await handleConnectRoute(
      req({
        query: {
          client_id: CLIENT,
          redirect_uri: REDIRECT,
          response_type: "code",
          code_challenge: CHALLENGE,
          code_challenge_method: "S256",
          resource: RESOURCE,
        },
      }),
      deps(),
    );
    const left = await pg.query("SELECT id FROM delegation.authorizations");
    expect(left.rows).toEqual([]);
    // The claimed authorization's Cognito token now belongs to the live
    // delegation, so cleanup leaves it alone.
    expect(revoked).toEqual([]);
    const [grant] = await listDelegations(client, TEST_USER_ID);
    expect(grant!.revoked_at_ms).toBeNull();
  });
});
