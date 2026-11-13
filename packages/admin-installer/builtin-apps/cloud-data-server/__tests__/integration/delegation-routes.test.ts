/**
 * Delegated access against one real Postgres: the delegation store's SQL,
 * and the delegated branch end to end through the broker's own routes.
 *
 * Every statement runs on PGlite, so this checks what the scripted-database
 * unit tests cannot: that a delegated call reads and writes exactly the
 * delegation's user's rows, that a row delete through a delegation leaves a
 * tombstone rather than removing the row, and that the store's queries cut by
 * user where they must.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { PGlite } from "@electric-sql/pglite";
import { signRequest } from "@starkeep/app-client";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import type { APIGatewayEvent, LambdaContext } from "../../src/handler-utils.js";
import {
  delegationSigningKeyFromPem,
  sealRefreshToken,
  signDelegationToken,
} from "../../src/delegation-tokens.js";
import {
  findDelegation,
  insertDelegation,
  listDelegations,
  loadConnectableApps,
  revokeDelegation,
  touchDelegation,
  TOUCH_INTERVAL_MS,
  type DelegationRow,
} from "../../src/delegation-store.js";
import { resetUserCheckCache } from "../../src/delegation-user-check.js";
import { installUserTokenFixture, mintTestUserToken } from "../user-token.js";
import { makeDelegationKeyPem } from "../delegation-key.js";
import {
  createAppNodeWatermarks,
  createSharedSchema,
} from "../../../../../storage-aurora-dsql/__tests__/pg-shared-schema.js";
import { dropAllUserSchemas } from "../../../../../storage-aurora-dsql/__tests__/pglite-reset.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const context: LambdaContext = {
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-cds",
};
const APP = "probe";
const A = "user-a";
const B = "user-b";
const CONNECTORS = "test-connectors-client";
const COGNITO = "teststack.auth.us-east-1.amazoncognito.com";
const key = delegationSigningKeyFromPem(makeDelegationKeyPem().privateKeyPem);

type HandlerModule = typeof import("../../src/api-handler.js");
let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];
let setKey: HandlerModule["__setDelegationSigningKeyForTests"];
let pg: PGlite;
let client: DatabaseClient;
let seq = 0;

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "pglite.test";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.AWS_REGION = "us-east-1";
  process.env.STARKEEP_COGNITO_DOMAIN = COGNITO;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await installUserTokenFixture();
  process.env.STARKEEP_CONNECTORS_USER_POOL_CLIENT_ID = CONNECTORS;
  const fixtureFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === `https://${COGNITO}/oauth2/token`) {
      // The stored refresh token names its user, so the minted ID token does.
      const refresh = new URLSearchParams(String(init?.body)).get("refresh_token")!;
      const sub = refresh.replace(/^refresh-/, "");
      return new Response(
        JSON.stringify({
          id_token: await mintTestUserToken({
            sub,
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
  await pg.exec(`DELETE FROM delegation.grants; DELETE FROM shared.app_registry;`);
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
  await createAppNodeWatermarks(pg, "app_probe");
  setDbFactory({ createClient: async () => client });
  setKey(key);
  resetUserCheckCache();

  ssmMock.reset();
  stsMock.reset();
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

/** A live delegation row for `userId`, stored, and its token. */
async function delegate(
  userId: string,
  mode: "read" | "readwrite",
  over: Partial<DelegationRow> = {},
): Promise<{ row: DelegationRow; token: string }> {
  const id = `dlg-${++seq}`;
  const row: DelegationRow = {
    id,
    user_id: userId,
    app_id: APP,
    channel: "app",
    mode,
    client_name: "test client",
    cognito_refresh_ciphertext: sealRefreshToken(key.refreshKey, id, `refresh-${userId}`),
    created_at_ms: Date.now(),
    expires_at_ms: Date.now() + 86_400_000,
    revoked_at_ms: null,
    last_used_at_ms: null,
    last_write_at_ms: null,
    ...over,
  };
  await insertDelegation(client, row);
  const token = signDelegationToken(key, {
    userId,
    appId: APP,
    delegationId: id,
    mode,
    channel: "app",
    expiresAtMs: row.expires_at_ms,
  });
  return { row, token };
}

async function call(token: string, method: string, subPath: string, body?: unknown) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    ...signRequest({
      appId: APP,
      hmacSecret: `secret-${APP}`,
      method,
      path: subPath,
      ...(raw !== undefined ? { body: raw } : {}),
    }),
    "X-Starkeep-Delegation": token,
    ...(raw !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const event: APIGatewayEvent = {
    rawPath: `/apps/${APP}${subPath}`,
    requestContext: { http: { method } },
    headers,
    ...(raw !== undefined ? { body: raw } : {}),
  };
  const res = (await handler(event, context)) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") as Record<string, unknown> };
}

describe("the delegated branch, on real SQL", () => {
  it("reads the delegation's user's rows and no one else's", async () => {
    const { token } = await delegate(A, "read");
    await pg.exec(
      `INSERT INTO app_probe.probe_notes VALUES ('${A}', 'a-1', 'A''s note', '0000000000000-0000-n', 'n', null)`,
    );
    const res = await call(token, "GET", "/app-data/db/probe_notes");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain("A's note");
    expect(text).not.toContain("B's note");
  });

  it("writes a readwrite delegation's row as its user, and deletes it by tombstone", async () => {
    const { token } = await delegate(A, "readwrite");
    const write = await call(token, "POST", "/app-data/db/probe_notes", {
      row: { record_id: "a-2", note: "outside" },
    });
    expect(write.status, JSON.stringify(write.body)).toBe(200);
    const stored = await pg.query<{ user_id: string; deleted_at: string | null }>(
      `SELECT user_id, deleted_at FROM app_probe.probe_notes WHERE record_id = 'a-2'`,
    );
    expect(stored.rows).toEqual([{ user_id: A, deleted_at: null }]);

    const del = await call(token, "DELETE", "/app-data/db/probe_notes", {
      where: { record_id: "a-2" },
    });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    const after = await pg.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM app_probe.probe_notes WHERE record_id = 'a-2'`,
    );
    // Still there: a delegation never removes data, it only tombstones.
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.deleted_at).not.toBeNull();
  });

  it("refuses a read delegation's write and leaves the table as it was", async () => {
    const { token } = await delegate(A, "read");
    const res = await call(token, "POST", "/app-data/db/probe_notes", {
      row: { record_id: "a-3", note: "no" },
    });
    expect(res.status).toBe(403);
    const rows = await pg.query(`SELECT 1 FROM app_probe.probe_notes WHERE record_id = 'a-3'`);
    expect(rows.rows).toEqual([]);
  });

  it("refuses a revoked delegation and an expired one", async () => {
    const revoked = await delegate(A, "read", { revoked_at_ms: Date.now() - 1 });
    expect((await call(revoked.token, "GET", "/app-data/db/probe_notes")).status).toBe(401);
    const expired = await delegate(A, "read", { expires_at_ms: Date.now() + 1 });
    await new Promise((r) => setTimeout(r, 5));
    // The token itself outlives the row here, so the row is what refuses.
    expect((await call(expired.token, "GET", "/app-data/db/probe_notes")).status).toBe(401);
  });

  it("refuses a token whose row names another user", async () => {
    const { row } = await delegate(B, "read");
    const forged = signDelegationToken(key, {
      userId: A,
      appId: APP,
      delegationId: row.id,
      mode: "read",
      channel: "app",
      expiresAtMs: row.expires_at_ms,
    });
    expect((await call(forged, "GET", "/app-data/db/probe_notes")).status).toBe(401);
  });

  it("records the first use, and the first write, once", async () => {
    const { row, token } = await delegate(A, "readwrite");
    await call(token, "GET", "/app-data/db/probe_notes");
    await call(token, "POST", "/app-data/db/probe_notes", { row: { record_id: "a-4", note: "x" } });
    const stored = (await findDelegation(client, row.id))!;
    expect(stored.last_used_at_ms).not.toBeNull();
    expect(stored.last_write_at_ms).not.toBeNull();
  });
});

describe("the delegation store", () => {
  it("lists one user's rows, newest first, and revokes only that user's", async () => {
    const older = await delegate(A, "read", { created_at_ms: 1 });
    const newer = await delegate(A, "readwrite", { created_at_ms: 2 });
    const theirs = await delegate(B, "read");
    expect((await listDelegations(client, A)).map((r) => r.id)).toEqual([
      newer.row.id,
      older.row.id,
    ]);

    // B's row is not A's to revoke.
    expect(await revokeDelegation(client, A, theirs.row.id, 5)).toBeNull();
    expect((await findDelegation(client, theirs.row.id))!.revoked_at_ms).toBeNull();

    const revoked = await revokeDelegation(client, A, older.row.id, 5);
    expect(revoked?.id).toBe(older.row.id);
    expect((await findDelegation(client, older.row.id))!.revoked_at_ms).toBe(5);
    // A second revoke changes nothing.
    expect(await revokeDelegation(client, A, older.row.id, 9)).toBeNull();
  });

  it("writes a use stamp at most once an hour", async () => {
    const { row } = await delegate(A, "read");
    await touchDelegation(client, row, false, 1_000);
    const once = (await findDelegation(client, row.id))!;
    expect(once.last_used_at_ms).toBe(1_000);
    await touchDelegation(client, once, false, 2_000);
    expect((await findDelegation(client, row.id))!.last_used_at_ms).toBe(1_000);
    await touchDelegation(client, once, false, 1_000 + TOUCH_INTERVAL_MS);
    expect((await findDelegation(client, row.id))!.last_used_at_ms).toBe(1_000 + TOUCH_INTERVAL_MS);
  });

  it("offers the consent page only installed web apps with a delegated route", async () => {
    const manifest = (routes: unknown[]) =>
      JSON.stringify({ infraRequirements: { compute: { handlers: [{ routes }] } } }).replace(
        /'/g,
        "''",
      );
    await pg.exec(`
      INSERT INTO shared.app_registry (app_id, version, name, web_app, manifest) VALUES
        ('probe', '1', 'Probe', true, '${manifest(["GET /", { route: "POST /mcp", auth: "delegated" }])}'),
        ('photos', '1', 'Photos', true, '${manifest(["GET /"])}'),
        ('drive-only', '1', null, false, '${manifest([{ route: "POST /mcp", auth: "delegated" }])}');
    `);
    expect(await loadConnectableApps(client)).toEqual([{ appId: "probe", name: "Probe" }]);
  });
});
