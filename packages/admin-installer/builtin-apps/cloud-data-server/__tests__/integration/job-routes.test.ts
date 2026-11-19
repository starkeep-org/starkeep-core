/**
 * The job routes and the job channel against one real Postgres: the app's
 * server lists a user's jobs and starts a run, and a run's token reads and
 * writes exactly its user's app rows while its lease holds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { PGlite } from "@electric-sql/pglite";
import { signRequest } from "@starkeep/app-client";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import type { APIGatewayEvent, LambdaContext } from "../../src/handler-utils.js";
import {
  delegationSigningKeyFromPem,
  sealRefreshToken,
  signDelegationToken,
} from "../../src/delegation-tokens.js";
import { resetUserCheckCache } from "../../src/delegation-user-check.js";
import {
  enrollmentId,
  findEnrollment,
  recordOutcome,
  revokeEnrollment,
  upsertEnrollment,
} from "../../src/job-store.js";
import { installUserTokenFixture, mintTestUserToken, TEST_USER_ID } from "../user-token.js";
import { makeDelegationKeyPem } from "../delegation-key.js";
import {
  createAppNodeWatermarks,
  createSharedSchema,
} from "../../../../../storage-aurora-dsql/__tests__/pg-shared-schema.js";
import { dropAllUserSchemas } from "../../../../../storage-aurora-dsql/__tests__/pglite-reset.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const lambdaMock = mockClient(LambdaClient);
const context: LambdaContext = {
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-cds",
};
const APP = "probe";
const A = TEST_USER_ID;
const B = "user-b";
const CONNECTORS = "test-connectors-client";
const COGNITO = "teststack.auth.us-east-1.amazoncognito.com";
const GATEWAY = "abc123.execute-api.us-east-1.amazonaws.com";
const key = delegationSigningKeyFromPem(makeDelegationKeyPem().privateKeyPem);
const MANIFEST = JSON.stringify({
  id: APP,
  infraRequirements: {
    compute: { enabled: true, handlers: [{ name: "api", timeoutSeconds: 30 }] },
    jobs: [
      {
        name: "tick",
        handler: "api",
        mode: "readwrite",
        defaultTime: "06:00",
        description: "Ticks.",
      },
      { name: "peek", handler: "api", mode: "read", defaultTime: null, description: "Peeks." },
    ],
  },
});

type HandlerModule = typeof import("../../src/api-handler.js");
let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];
let setKey: HandlerModule["__setDelegationSigningKeyForTests"];
let pg: PGlite;
let client: DatabaseClient;
let userToken: string;

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "pglite.test";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.STARKEEP_COGNITO_DOMAIN = COGNITO;
  process.env.STARKEEP_DISPATCHER_FUNCTION = "teststack-app-cloud-data-server-dispatcher";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ token: userToken } = await installUserTokenFixture());
  process.env.STARKEEP_CONNECTORS_USER_POOL_CLIENT_ID = CONNECTORS;
  const fixtureFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === `https://${COGNITO}/oauth2/token`) {
      const refresh = new URLSearchParams(String(init?.body)).get("refresh_token")!;
      return new Response(
        JSON.stringify({
          id_token: await mintTestUserToken({
            sub: refresh.replace(/^refresh-/, ""),
            aud: CONNECTORS,
            "cognito:groups": ["starkeep-users"],
          }),
        }),
      );
    }
    return fixtureFetch(input, init);
  });
  const mod = await import("../../src/api-handler.js");
  handler = mod.handler;
  setDbFactory = mod.__setDatabaseClientFactoryForTests;
  setKey = mod.__setDelegationSigningKeyForTests;
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
  setDbFactory(null);
});

beforeEach(async () => {
  await dropAllUserSchemas(pg);
  await createSharedSchema(pg);
  const tables = [
    {
      name: "probe_notes",
      pkColumns: ["record_id"],
      columns: [
        { name: "record_id", type: "text", notNull: true, primaryKey: true },
        { name: "note", type: "text", notNull: false, primaryKey: false },
      ],
    },
  ];
  await pg.exec(`
    CREATE SCHEMA app_probe;
    CREATE TABLE app_probe.probe_notes (
      user_id text NOT NULL,
      record_id text NOT NULL,
      note text,
      updated_at text NOT NULL,
      node_id text NOT NULL,
      deleted_at text,
      PRIMARY KEY (user_id, record_id)
    );
    CREATE TABLE app_probe._starkeep_byte_coverage (
      user_id text NOT NULL,
      node_id text NOT NULL,
      hlc text NOT NULL,
      PRIMARY KEY (user_id, node_id)
    );
    INSERT INTO shared.app_syncable_namespaces (app_id, tables_json, files_enabled)
      VALUES ('${APP}', '${JSON.stringify(tables)}', false);
    INSERT INTO app_probe.probe_notes VALUES
      ('${B}', 'b-1', 'B''s note', '0000000000000-0000-n', 'n', null);
  `);
  await pg.query(
    `INSERT INTO shared.app_registry (app_id, version, name, web_app, manifest) VALUES ($1, '1', 'Probe', true, $2)`,
    [APP, MANIFEST],
  );
  await createAppNodeWatermarks(pg, "app_probe");
  setDbFactory({ createClient: async () => client });
  setKey(key);
  resetUserCheckCache();

  ssmMock.reset();
  stsMock.reset();
  lambdaMock.reset();
  lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
  ssmMock.on(GetParameterCommand).callsFake(async (input: { Name?: string }) => {
    const appId = input.Name!.split("/").pop()!;
    return { Parameter: { Value: JSON.stringify({ hmacSecret: `secret-${appId}` }) } };
  });
  stsMock.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: "AKIAFAKE",
      SecretAccessKey: "fake-secret",
      SessionToken: "fake-token",
      Expiration: new Date(Date.now() + 900_000),
    },
  });
});

async function enroll(userId: string, job: string, mode: "read" | "readwrite" = "readwrite") {
  const id = enrollmentId(userId, APP, job);
  await upsertEnrollment(
    client,
    {
      id,
      user_id: userId,
      app_id: APP,
      job,
      mode,
      time_zone: "Europe/London",
      time_of_day: "07:30",
      cognito_refresh_ciphertext: sealRefreshToken(key.refreshKey, id, `refresh-${userId}`),
      next_due_at_ms: Date.now() + 3_600_000,
    },
    Date.now(),
  );
  return id;
}

async function call(
  method: string,
  subPath: string,
  auth: { user?: string; delegation?: string; sign?: boolean },
  body?: unknown,
) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    ...(auth.sign === false
      ? {}
      : signRequest({
          appId: APP,
          hmacSecret: `secret-${APP}`,
          method,
          path: subPath,
          ...(raw !== undefined ? { body: raw } : {}),
        })),
    ...(auth.user ? { "X-Starkeep-User-Token": auth.user } : {}),
    ...(auth.delegation ? { "X-Starkeep-Delegation": auth.delegation } : {}),
    ...(raw !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const event: APIGatewayEvent = {
    rawPath: `/apps/${APP}${subPath}`,
    requestContext: { http: { method }, domainName: GATEWAY },
    headers,
    ...(raw !== undefined ? { body: raw } : {}),
  };
  const res = (await handler(event, context)) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") as Record<string, unknown> };
}

describe("GET /apps/<appId>/jobs", () => {
  it("lists the app's jobs with this user's enrollment in each", async () => {
    await enroll(A, "tick");
    await enroll(B, "peek", "read");
    const res = await call("GET", "/jobs", { user: userToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const jobs = res.body.jobs as Record<string, unknown>[];
    expect(jobs.map((j) => [j.name, j.enabled])).toEqual([
      ["tick", true],
      ["peek", false],
    ]);
    expect(jobs[0]).toMatchObject({
      mode: "readwrite",
      defaultTime: "06:00",
      timeOfDay: "07:30",
      timeZone: "Europe/London",
      running: false,
      lastRun: null,
      attention: null,
    });
    expect(jobs[1]!.consentUrl).toBe(`https://${GATEWAY}/connect/job?app=probe&job=peek`);
  });

  it("answers 404 for an app with no cloud web app", async () => {
    await pg.query(`UPDATE shared.app_registry SET web_app = false`);
    expect((await call("GET", "/jobs", { user: userToken })).status).toBe(404);
  });
});

describe("POST /apps/<appId>/jobs/<name>/run", () => {
  it("claims the lease, hands the run to the dispatcher and answers 202", async () => {
    const id = await enroll(A, "tick");
    const res = await call("POST", "/jobs/tick/run", { user: userToken });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const row = (await findEnrollment(client, id))!;
    expect(row.lease_id).toBe(res.body.runId);
    expect(row.lease_until_ms).toBeGreaterThan(Date.now() + 80_000);
    // A manual run leaves the schedule alone.
    expect(row.next_due_at_ms).toBeGreaterThan(Date.now() + 3_500_000);
    const invokes = lambdaMock.commandCalls(InvokeCommand);
    expect(invokes).toHaveLength(1);
    expect(invokes[0]!.args[0].input).toMatchObject({
      FunctionName: "teststack-app-cloud-data-server-dispatcher",
      InvocationType: "Event",
    });
    expect(
      JSON.parse(Buffer.from(invokes[0]!.args[0].input.Payload as Uint8Array).toString()),
    ).toEqual({ kind: "run", enrollmentId: id, leaseId: res.body.runId });

    // A second "run now" while the first holds the lease.
    expect((await call("POST", "/jobs/tick/run", { user: userToken })).body).toMatchObject({
      code: "running",
    });
  });

  it("answers 409 without a live enrollment, and 404 for an unknown job", async () => {
    expect((await call("POST", "/jobs/tick/run", { user: userToken })).status).toBe(409);
    const id = await enroll(A, "tick");
    await revokeEnrollment(client, A, id, Date.now());
    expect((await call("POST", "/jobs/tick/run", { user: userToken })).status).toBe(409);
    expect((await call("POST", "/jobs/nope/run", { user: userToken })).status).toBe(404);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it("releases the lease when the dispatcher cannot be reached", async () => {
    const id = await enroll(A, "tick");
    lambdaMock.on(InvokeCommand).rejects(new Error("boom"));
    expect((await call("POST", "/jobs/tick/run", { user: userToken })).status).toBe(503);
    expect(await findEnrollment(client, id)).toMatchObject({
      lease_id: null,
      last_status: "failed",
    });
  });
});

describe("a run's token", () => {
  async function runToken(userId: string, job = "tick") {
    const id = await enroll(userId, job);
    const userJwt = userId === A ? userToken : await mintTestUserToken({ sub: userId });
    const started = await call("POST", `/jobs/${job}/run`, { user: userJwt });
    expect(started.status).toBe(202);
    const row = (await findEnrollment(client, id))!;
    const token = signDelegationToken(key, {
      userId,
      appId: APP,
      delegationId: id,
      mode: "readwrite",
      channel: "job",
      job: { name: job, runId: row.lease_id! },
      expiresAtMs: row.lease_until_ms!,
    });
    return { id, token, leaseId: row.lease_id! };
  }

  it("reads and writes its user's rows only, while its lease holds", async () => {
    const { id, token, leaseId } = await runToken(A);
    const write = await call(
      "POST",
      "/app-data/db/probe_notes",
      { delegation: token },
      {
        row: { record_id: "a-1", note: "from the job" },
      },
    );
    expect(write.status, JSON.stringify(write.body)).toBe(200);
    const read = await call("GET", "/app-data/db/probe_notes", { delegation: token });
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).toContain("from the job");
    expect(JSON.stringify(read.body)).not.toContain("B's note");
    const stored = await pg.query<{ user_id: string }>(
      `SELECT user_id FROM app_probe.probe_notes WHERE record_id = 'a-1'`,
    );
    expect(stored.rows).toEqual([{ user_id: A }]);

    // The run ends; the row cache would still admit it on this container for
    // up to a minute, so drop the cache as a new container would see it.
    await recordOutcome(client, id, leaseId, { status: "ok", message: null }, Date.now());
    setKey(key);
    expect((await call("GET", "/app-data/db/probe_notes", { delegation: token })).status).toBe(401);
  });

  it("cannot list or start jobs", async () => {
    const { token } = await runToken(A);
    expect((await call("GET", "/jobs", { delegation: token })).status).toBe(403);
    expect((await call("POST", "/jobs/peek/run", { delegation: token })).status).toBe(403);
  });
});

describe("the platform's job path", () => {
  it("answers 404 at the broker for every caller, so the gateway route reveals nothing", async () => {
    await enroll(A, "tick");
    for (const auth of [{ user: userToken }, { sign: false }]) {
      for (const method of ["GET", "POST"]) {
        const res = await call(method, "/_starkeep/jobs/tick", auth);
        expect(res.status, `${method} ${JSON.stringify(auth)}`).toBe(404);
      }
    }
  });
});

describe("other callers", () => {
  it("a signed-in device cannot reach the job routes", async () => {
    await enroll(A, "tick");
    // A device token without the app's signature takes the device branch.
    process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID = "test-client-id";
    const res = await call("POST", "/jobs/tick/run", { user: userToken, sign: false });
    delete process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID;
    expect(res.status).toBe(403);
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it("an outside client's delegation cannot reach the job routes", async () => {
    const token = signDelegationToken(key, {
      userId: A,
      appId: APP,
      delegationId: "dlg-x",
      mode: "readwrite",
      channel: "app",
      expiresAtMs: Date.now() + 60_000,
    });
    // Refused by the policy before the row lookup, so no row is needed.
    expect((await call("GET", "/jobs", { delegation: token })).status).toBe(403);
  });
});
