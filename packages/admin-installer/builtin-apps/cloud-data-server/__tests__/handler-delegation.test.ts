/**
 * The delegated branch: an app's own server calls the broker for an outside
 * client, with the app's signature and the client's delegation token.
 *
 * The admission checks run in order (signature and `aud`, mode allowlist,
 * row, user check), and the branch never falls back to another: a refused
 * delegation must not get a second chance as the app's own session.
 *
 * "Gate passed" shows as a status other than 401 or 403: past the gate the
 * request reaches the scripted database, which answers only what a case
 * scripts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand, ParameterNotFound } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { signRequest } from "@starkeep/app-client";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import {
  delegationSigningKeyFromPem,
  sealRefreshToken,
  signDelegationToken,
} from "../src/delegation-tokens.js";
import { resetUserCheckCache } from "../src/delegation-user-check.js";
import type { DelegationRow } from "../src/delegation-store.js";
import { FakeDsql } from "./fake-dsql.js";
import { makeDelegationKeyPem } from "./delegation-key.js";
import { installUserTokenFixture, mintTestUserToken, TEST_USER_ID } from "./user-token.js";

type HandlerModule = typeof import("../src/api-handler.js");

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const context: LambdaContext = {
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-cds",
};

const CONNECTORS = "test-connectors-client";
const COGNITO_DOMAIN = "teststack.auth.us-east-1.amazoncognito.com";
const APP = "probe";
const SECRET = "probe-secret";
const key = delegationSigningKeyFromPem(makeDelegationKeyPem().privateKeyPem);

let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];
let setKey: HandlerModule["__setDelegationSigningKeyForTests"];
let db: FakeDsql;
/** What Cognito's token endpoint answers for a refresh. */
let refreshAnswer: () => Promise<Response>;
let refreshCalls = 0;

function row(over: Partial<DelegationRow> = {}): DelegationRow {
  const id = over.id ?? "dlg-1";
  return {
    id,
    user_id: TEST_USER_ID,
    app_id: APP,
    channel: "app",
    mode: "read",
    client_name: "Claude Code",
    cognito_refresh_ciphertext: sealRefreshToken(key.refreshKey, id, "refresh-1"),
    created_at_ms: Date.now() - 1000,
    expires_at_ms: Date.now() + 86_400_000,
    revoked_at_ms: null,
    last_used_at_ms: Date.now(),
    last_write_at_ms: Date.now(),
    ...over,
  };
}

function token(over: Partial<Parameters<typeof signDelegationToken>[1]> = {}): string {
  return signDelegationToken(key, {
    userId: TEST_USER_ID,
    appId: APP,
    delegationId: "dlg-1",
    mode: "read",
    channel: "app",
    expiresAtMs: Date.now() + 86_400_000,
    ...over,
  });
}

function call(args: {
  method: string;
  subPath: string;
  delegation?: string;
  body?: string;
  sign?: boolean;
  appId?: string;
  extra?: Record<string, string>;
}): Promise<{ statusCode: number; body: string }> {
  const appId = args.appId ?? APP;
  const headers: Record<string, string> = {
    ...(args.sign === false
      ? {}
      : signRequest({
          appId,
          hmacSecret: SECRET,
          method: args.method,
          path: args.subPath,
          ...(args.body !== undefined ? { body: args.body } : {}),
        })),
    ...(args.delegation !== undefined ? { "X-Starkeep-Delegation": args.delegation } : {}),
    ...(args.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(args.extra ?? {}),
  };
  const event: APIGatewayEvent = {
    rawPath: `/apps/${appId}${args.subPath}`,
    requestContext: { http: { method: args.method } },
    headers,
    ...(args.body !== undefined ? { body: args.body } : {}),
  };
  return handler(event, context) as Promise<{ statusCode: number; body: string }>;
}

function passedGate(res: { statusCode: number }): boolean {
  return res.statusCode !== 401 && res.statusCode !== 403 && res.statusCode !== 400;
}

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "invalid.test.localdomain";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.HMAC_CACHE_TTL_MS = "0";
  process.env.STARKEEP_COGNITO_DOMAIN = COGNITO_DOMAIN;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await installUserTokenFixture();
  process.env.STARKEEP_CONNECTORS_USER_POOL_CLIENT_ID = CONNECTORS;

  const fixtureFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === `https://${COGNITO_DOMAIN}/oauth2/token`) {
      refreshCalls += 1;
      return refreshAnswer();
    }
    return fixtureFetch(input, init);
  });

  const mod = await import("../src/api-handler.js");
  handler = mod.handler;
  setDbFactory = mod.__setDatabaseClientFactoryForTests;
  setKey = mod.__setDelegationSigningKeyForTests;
});

beforeEach(() => {
  ssmMock.reset();
  stsMock.reset();
  stsMock.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: "AKIAFAKE",
      SecretAccessKey: "fake-secret",
      SessionToken: "fake-token",
      Expiration: new Date(Date.now() + 900_000),
    },
  });
  ssmMock
    .on(GetParameterCommand)
    .rejects(new ParameterNotFound({ message: "not found", $metadata: {} }));
  ssmMock
    .on(GetParameterCommand, { Name: `/teststack/app-creds/${APP}`, WithDecryption: true })
    .resolves({ Parameter: { Value: JSON.stringify({ hmacSecret: SECRET }) } });

  setKey(key);
  resetUserCheckCache();
  refreshCalls = 0;
  refreshAnswer = async () =>
    new Response(
      JSON.stringify({
        id_token: await mintTestUserToken({
          aud: CONNECTORS,
          exp: Math.floor(Date.now() / 1000) + 900,
          "cognito:groups": ["starkeep-users"],
        }),
      }),
      { status: 200 },
    );
  db = new FakeDsql();
  db.on(/from "delegation"\."grants"/, [row() as unknown as Record<string, unknown>]);
  db.on(/update "delegation"\."grants"/, []);
  setDbFactory(db);
});

describe("admits", () => {
  it("a read delegation reading app rows", async () => {
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: token(),
    });
    expect(passedGate(res), res.body).toBe(true);
    expect(refreshCalls).toBe(1);
  });

  it("a read delegation writing a label", async () => {
    const res = await call({
      method: "POST",
      subPath: "/data/labels",
      delegation: token(),
      body: "{}",
    });
    expect(passedGate(res), res.body).toBe(true);
  });

  it("asks Cognito once per ID token's life, not once per call", async () => {
    await call({ method: "GET", subPath: "/app-data/db/probe_notes", delegation: token() });
    await call({ method: "GET", subPath: "/app-data/db/probe_notes", delegation: token() });
    expect(refreshCalls).toBe(1);
  });
});

describe("refuses", () => {
  it("a read delegation writing an app row", async () => {
    const res = await call({
      method: "POST",
      subPath: "/app-data/db/probe_notes",
      delegation: token(),
      body: JSON.stringify({ row: { record_id: "x" } }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("a readwrite delegation erasing a file", async () => {
    db = new FakeDsql().on(/from "delegation"\."grants"/, [
      row({ mode: "readwrite" }) as unknown as Record<string, unknown>,
    ]);
    setDbFactory(db);
    const res = await call({
      method: "DELETE",
      subPath: "/app-data/files/notes/a.txt",
      delegation: token({ mode: "readwrite" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("a call without the app's signature", async () => {
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: token(),
      sign: false,
    });
    expect(res.statusCode).toBe(401);
  });

  it("a token for another app", async () => {
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: token({ appId: "photos" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("a platform-channel token", async () => {
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: token({ channel: "platform" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("a revoked delegation, at once", async () => {
    db = new FakeDsql().on(/from "delegation"\."grants"/, [
      row({ revoked_at_ms: Date.now() - 1 }) as unknown as Record<string, unknown>,
    ]);
    setDbFactory(db);
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: token(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("a token whose mode differs from its row", async () => {
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: token({ mode: "readwrite" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("a delegation whose user signed out everywhere, and revokes the row", async () => {
    refreshAnswer = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: token(),
    });
    expect(res.statusCode).toBe(401);
    expect(db.calls(/update "delegation"\."grants" set "revoked_at_ms"/)).toHaveLength(1);
  });

  it("a user who left the data group", async () => {
    refreshAnswer = async () =>
      new Response(
        JSON.stringify({
          id_token: await mintTestUserToken({ aud: CONNECTORS, "cognito:groups": [] }),
        }),
        { status: 200 },
      );
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: token(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("a user token beside the delegation, rather than choosing one", async () => {
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: token(),
      extra: { "X-Starkeep-User-Token": await mintTestUserToken() },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a bad token, without falling back to the app's own branch", async () => {
    const res = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      delegation: "skd_not.a.token",
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("the connectors client", () => {
  it("is accepted on no data branch", async () => {
    const connectorsToken = await mintTestUserToken({
      aud: CONNECTORS,
      "cognito:groups": ["starkeep-users"],
    });
    // The app's own branch.
    const hmac = await call({
      method: "GET",
      subPath: "/app-data/db/probe_notes",
      extra: { "X-Starkeep-User-Token": connectorsToken },
    });
    expect(hmac.statusCode).toBe(401);
    // The device branch: a bare token with no signature.
    process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID = "test-device-client";
    try {
      const device = await call({
        method: "POST",
        subPath: "/sync/exchange",
        sign: false,
        body: "{}",
        extra: { "X-Starkeep-User-Token": connectorsToken },
      });
      expect(device.statusCode).toBe(401);
    } finally {
      delete process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID;
    }
  });
});

describe("the consent pages", () => {
  it("do not answer through CloudFront", async () => {
    for (const path of ["/connect", "/connections", "/connect/jwks.json"]) {
      const res = (await handler(
        {
          rawPath: path,
          requestContext: { http: { method: "GET" }, domainName: "abc.execute-api.test" },
          headers: { "x-starkeep-origin": "anything" },
        },
        context,
      )) as { statusCode: number };
      expect(res.statusCode, path).toBe(404);
    }
  });

  it("publish the public key on the gateway's own hostname", async () => {
    const res = (await handler(
      {
        rawPath: "/connect/jwks.json",
        requestContext: { http: { method: "GET" }, domainName: "abc.execute-api.test" },
        headers: {},
      },
      context,
    )) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).keys[0].kid).toBe(key.kid);
  });
});
