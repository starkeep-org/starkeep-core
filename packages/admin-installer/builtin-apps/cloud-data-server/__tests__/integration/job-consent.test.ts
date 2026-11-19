/**
 * The job consent page and the connections page's background jobs, on one
 * real Postgres: turning a job on through managed login writes the
 * enrollment, and the connections page re-times it and turns it off.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  handleConnectRoute,
  type ConnectDeps,
  type ConnectRequest,
  type ConnectResponse,
} from "../../src/connect-routes.js";
import { delegationSigningKeyFromPem, openRefreshToken } from "../../src/delegation-tokens.js";
import { nextDueAt } from "../../src/job-schedule.js";
import { enrollmentId, findEnrollment, stopEnrollment } from "../../src/job-store.js";
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
const key = delegationSigningKeyFromPem(makeDelegationKeyPem().privateKeyPem);
const ID = enrollmentId(TEST_USER_ID, "probe", "tick");

let pg: PGlite;
let client: DatabaseClient;
let now: number;
let revoked: string[];
let forgotten: string[];
let codeSeq: number;

function deps(): ConnectDeps {
  return {
    pool: { region: TEST_REGION, userPoolId: TEST_POOL_ID, userPoolClientId: CONNECTORS },
    cognitoDomain: COGNITO,
    host: HOST,
    signingKey: async () => key,
    db: async () => client,
    connectableApps: async () => [],
    viewerHosts: async () => ["cloud.example.com"],
    publicHost: async () => "cloud.example.com",
    groupsMayUseData: (g) => g.includes("starkeep-users"),
    forgetDelegation: (id) => forgotten.push(id),
    now: () => now,
    fetch: async (input, init) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (String(input).endsWith("/oauth2/revoke")) {
        revoked.push(body.get("token")!);
        return new Response("", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id_token: await mintTestUserToken({
            aud: CONNECTORS,
            "cognito:groups": ["starkeep-users"],
          }),
          refresh_token: `cognito-refresh-${body.get("code")}`,
        }),
      );
    },
  };
}

function req(over: Partial<ConnectRequest>): ConnectRequest {
  return {
    method: "GET",
    rawPath: "/connect/job",
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

const POST = { method: "POST", headers: { "sec-fetch-site": "same-origin" } } as const;

/** Open the consent page, approve with `form`, sign in, and answer the final page. */
async function turnOn(
  query: Record<string, string>,
  form: Record<string, string>,
): Promise<{ page: ConnectResponse; consent: ConnectResponse }> {
  const consent = await handleConnectRoute(req({ query }), deps());
  let cookies = jar(consent);
  const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)![1]!;
  const fields = Object.fromEntries(
    [...consent.body.matchAll(/type="hidden" name="(app|job|return)" value="([^"]*)"/g)].map(
      (m) => [m[1]!, m[2]!.replace(/&#x2F;|&#47;/g, "/")],
    ),
  );
  const approved = await handleConnectRoute(
    req({
      ...POST,
      rawPath: "/connect/job/approve",
      cookieHeader: cookies,
      body: new URLSearchParams({ csrf, ...fields, ...form }).toString(),
    }),
    deps(),
  );
  expect(approved.statusCode, approved.body).toBe(302);
  cookies = jar(approved, cookies);
  const state = new URL(approved.headers.Location!).searchParams.get("state")!;
  const page = await handleConnectRoute(
    req({
      rawPath: "/connect/callback",
      query: { state, code: `c${++codeSeq}` },
      cookieHeader: cookies,
    }),
    deps(),
  );
  return { page, consent };
}

async function installProbe(jobs: unknown[]) {
  await pg.query(
    `INSERT INTO shared.app_registry (app_id, version, name, web_app, manifest) VALUES ('probe', '1', 'Probe', true, $1)
     ON CONFLICT (app_id) DO UPDATE SET manifest = excluded.manifest`,
    [
      JSON.stringify({
        infraRequirements: {
          compute: { enabled: true, handlers: [{ name: "api", timeoutSeconds: 30 }] },
          jobs,
        },
      }),
    ],
  );
}

const TICK = {
  name: "tick",
  handler: "api",
  mode: "readwrite",
  defaultTime: "06:30",
  description: "Pulls yesterday's workouts.",
};

beforeAll(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await installUserTokenFixture();
  pg = new PGlite();
  await pg.waitReady;
  client = {
    async query(text, values) {
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
  await installProbe([TICK]);
  now = Date.parse("2026-11-19T12:00:00Z");
  revoked = [];
  forgotten = [];
  codeSeq = 0;
});

describe("the job consent page", () => {
  it("shows the job, its default time and the browser's zone", async () => {
    const page = await handleConnectRoute(
      req({ query: { app: "probe", job: "tick", tz: "America/New_York" } }),
      deps(),
    );
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Pulls yesterday&#39;s workouts.");
    expect(page.body).toContain("read and change your data in Probe");
    expect(page.body).toContain('name="time" value="06:30"');
    expect(page.body).toContain('<option value="America/New_York" selected>');
    expect(page.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("falls back to UTC for an unknown zone, and to the app's root for a foreign return path", async () => {
    const page = await handleConnectRoute(
      req({
        query: { app: "probe", job: "tick", tz: "Nowhere/Land", return: "https://evil.example/" },
      }),
      deps(),
    );
    expect(page.body).toContain('<option value="UTC" selected>');
    expect(page.body).toMatch(/name="return" value="(\/|&#x2F;)apps(\/|&#x2F;)probe(\/|&#x2F;)"/);
  });

  it("answers 404 for a job the app does not offer", async () => {
    const page = await handleConnectRoute(req({ query: { app: "probe", job: "nope" } }), deps());
    expect(page.statusCode).toBe(404);
  });

  it("refuses an approval without the CSRF token or from another origin", async () => {
    const body = new URLSearchParams({ app: "probe", job: "tick", when: "manual" }).toString();
    const noCsrf = await handleConnectRoute(
      req({ ...POST, rawPath: "/connect/job/approve", body }),
      deps(),
    );
    expect(noCsrf.statusCode).toBe(403);
    const cross = await handleConnectRoute(
      req({
        method: "POST",
        rawPath: "/connect/job/approve",
        headers: { "sec-fetch-site": "cross-site" },
        body,
      }),
      deps(),
    );
    expect(cross.statusCode).toBe(403);
  });
});

describe("turning a job on", () => {
  it("writes the enrollment with the user's time and zone, and links back to the app", async () => {
    const { page } = await turnOn(
      { app: "probe", job: "tick", tz: "Europe/London", return: "/apps/probe/settings" },
      { when: "time", time: "07:15", tz: "Europe/London" },
    );
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).toContain('href="https://cloud.example.com/apps/probe/settings"');
    const row = (await findEnrollment(client, ID))!;
    expect(row).toMatchObject({
      user_id: TEST_USER_ID,
      app_id: "probe",
      job: "tick",
      mode: "readwrite",
      time_zone: "Europe/London",
      time_of_day: "07:15",
      next_due_at_ms: nextDueAt("Europe/London", "07:15", now),
      revoked_at_ms: null,
    });
    expect(openRefreshToken(key.refreshKey, ID, row.cognito_refresh_ciphertext)).toBe(
      "cognito-refresh-c1",
    );
    expect(forgotten).toContain(ID);
  });

  it("stores a manual-only job with no time and no due time", async () => {
    await turnOn({ app: "probe", job: "tick" }, { when: "manual" });
    expect(await findEnrollment(client, ID)).toMatchObject({
      time_of_day: null,
      next_due_at_ms: null,
    });
  });

  it("turns a stopped job on again with a fresh refresh token, and ends the old one", async () => {
    await turnOn({ app: "probe", job: "tick" }, { when: "manual" });
    await stopEnrollment(client, ID, "needs-consent", "changed", now);
    await turnOn({ app: "probe", job: "tick" }, { when: "time", time: "05:00", tz: "UTC" });
    const row = (await findEnrollment(client, ID))!;
    expect(row).toMatchObject({ attention: null, time_of_day: "05:00" });
    expect(openRefreshToken(key.refreshKey, ID, row.cognito_refresh_ciphertext)).toBe(
      "cognito-refresh-c2",
    );
    expect(revoked).toEqual(["cognito-refresh-c1"]);
  });

  it("refuses at the callback a job the app dropped during the sign-in", async () => {
    const consent = await handleConnectRoute(req({ query: { app: "probe", job: "tick" } }), deps());
    let cookies = jar(consent);
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.body)![1]!;
    const approved = await handleConnectRoute(
      req({
        ...POST,
        rawPath: "/connect/job/approve",
        cookieHeader: cookies,
        body: new URLSearchParams({ csrf, app: "probe", job: "tick", when: "manual" }).toString(),
      }),
      deps(),
    );
    cookies = jar(approved, cookies);
    await installProbe([]);
    const state = new URL(approved.headers.Location!).searchParams.get("state")!;
    const page = await handleConnectRoute(
      req({ rawPath: "/connect/callback", query: { state, code: "c9" }, cookieHeader: cookies }),
      deps(),
    );
    expect(page.statusCode).toBe(404);
    expect(await findEnrollment(client, ID)).toBeNull();
    expect(revoked).toEqual(["cognito-refresh-c9"]);
  });
});

describe("the connections page's background jobs", () => {
  async function session(): Promise<{ cookies: string; csrf: string; body: string }> {
    const idToken = await mintTestUserToken({
      aud: CONNECTORS,
      "cognito:groups": ["starkeep-users"],
    });
    const page = await handleConnectRoute(
      req({ rawPath: "/connections", cookieHeader: `sk_connections=${idToken}` }),
      deps(),
    );
    expect(page.statusCode, page.body).toBe(200);
    return {
      cookies: jar(page, `sk_connections=${idToken}`),
      // A page with nothing to change shows no form, so no token.
      csrf: /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? "",
      body: page.body,
    };
  }

  it("lists the job with its schedule and a reason when it needs the user", async () => {
    await turnOn(
      { app: "probe", job: "tick" },
      { when: "time", time: "07:15", tz: "Europe/London" },
    );
    await stopEnrollment(client, ID, "signed-out", "x", now);
    const { body } = await session();
    expect(body).toContain("Background jobs");
    expect(body).toContain("Every day at 07:15");
    expect(body).toContain("You signed out everywhere");
    expect(body).toContain("Turn it on again");
    expect(body).toContain(`/connections/jobs/${ID}/schedule`);
  });

  it("re-times a job, and turns it off at the database and at Cognito", async () => {
    await turnOn({ app: "probe", job: "tick" }, { when: "manual" });
    const { cookies, csrf } = await session();
    const retime = await handleConnectRoute(
      req({
        ...POST,
        rawPath: `/connections/jobs/${ID}/schedule`,
        cookieHeader: cookies,
        body: new URLSearchParams({
          csrf,
          when: "time",
          time: "21:45",
          tz: "Asia/Kolkata",
        }).toString(),
      }),
      deps(),
    );
    expect(retime.statusCode).toBe(302);
    expect(await findEnrollment(client, ID)).toMatchObject({
      time_of_day: "21:45",
      time_zone: "Asia/Kolkata",
      next_due_at_ms: nextDueAt("Asia/Kolkata", "21:45", now),
    });

    const off = await handleConnectRoute(
      req({
        ...POST,
        rawPath: `/connections/jobs/${ID}/revoke`,
        cookieHeader: cookies,
        body: new URLSearchParams({ csrf }).toString(),
      }),
      deps(),
    );
    expect(off.statusCode).toBe(302);
    const row = (await findEnrollment(client, ID))!;
    expect(row.revoked_at_ms).toBe(now);
    expect(row.next_due_at_ms).toBeNull();
    expect(revoked).toEqual(["cognito-refresh-c1"]);
    expect((await session()).body).toContain("No app runs a background job for you.");
  });

  it("refuses a change without the CSRF token, or for another user's job", async () => {
    await turnOn({ app: "probe", job: "tick" }, { when: "manual" });
    const { cookies } = await session();
    const noCsrf = await handleConnectRoute(
      req({ ...POST, rawPath: `/connections/jobs/${ID}/revoke`, cookieHeader: cookies, body: "" }),
      deps(),
    );
    expect(noCsrf.statusCode).toBe(403);

    const other = enrollmentId("someone-else", "probe", "tick");
    await pg.query(`UPDATE delegation.jobs SET id = $1, user_id = 'someone-else' WHERE id = $2`, [
      other,
      ID,
    ]);
    const { cookies: c2 } = await session();
    const csrf = /sk_connect_csrf=([^;]+)/.exec(c2)![1]!;
    const res = await handleConnectRoute(
      req({
        ...POST,
        rawPath: `/connections/jobs/${other}/revoke`,
        cookieHeader: c2,
        body: new URLSearchParams({ csrf }).toString(),
      }),
      deps(),
    );
    // Past the CSRF and origin checks, the revoke matched no row of this user's.
    expect(res.statusCode).toBe(302);
    expect((await findEnrollment(client, other))!.revoked_at_ms).toBeNull();
    expect(revoked).toEqual([]);
  });
});
