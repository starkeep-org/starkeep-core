/**
 * The broker's mobile branch: a mobile app registers an attested key, then
 * signs every request with it, and acts with its own app's grants alone.
 *
 * Same harness convention as `handler-device-token.test.ts`: the database is
 * a fake client that answers the mobile-identity reads and throws on anything
 * else, so "gate passed" is observable as a 500 and "gate refused" as a 401
 * or 403. `integration/two-users-routes.test.ts` drives the scoped exchange
 * against real SQL.
 */
import { createHash, sign } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SSMClient,
  GetParameterCommand,
  ParameterAlreadyExists,
  ParameterNotFound,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { SecurityLevel } from "@peculiar/asn1-android";
import { mobileSignedMessage } from "@starkeep/protocol-primitives";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import { resetMobileKeyCaches } from "../src/mobile-keys.js";
import { installUserTokenFixture, mintTestUserToken } from "./user-token.js";
import {
  TEST_CERT_DIGEST,
  TEST_PACKAGE,
  testAuthority,
  type KeyPair,
} from "./attestation-chain.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const context: LambdaContext = {
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-cds",
};
const MOBILE_CLIENT_ID = "test-mobile-client";
const authority = testAuthority();

type HandlerModule = typeof import("../src/api-handler.js");
let handler: HandlerModule["handler"];
let setAttestation: HandlerModule["__setAttestationForTests"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];

/** SSM parameters the broker has written. */
let parameters: Map<string, string>;
/** The apps whose Android build is registered. */
let identities: Array<{ app_id: string; android_package: string; android_cert_digests: string }>;

function mobileToken(over: Record<string, unknown> = {}): Promise<string> {
  return mintTestUserToken({
    aud: MOBILE_CLIENT_ID,
    "cognito:groups": ["starkeep-users"],
    ...over,
  });
}

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "fake.test";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.HMAC_CACHE_TTL_MS = "0";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await installUserTokenFixture();
  process.env.STARKEEP_MOBILE_USER_POOL_CLIENT_ID = MOBILE_CLIENT_ID;
  const mod = await import("../src/api-handler.js");
  handler = mod.handler;
  setAttestation = mod.__setAttestationForTests;
  setDbFactory = mod.__setDatabaseClientFactoryForTests;
});

beforeEach(() => {
  resetMobileKeyCaches();
  setAttestation([authority.rootPem], new Set());
  parameters = new Map();
  identities = [
    {
      app_id: "photos",
      android_package: TEST_PACKAGE,
      android_cert_digests: JSON.stringify([TEST_CERT_DIGEST]),
    },
  ];
  setDbFactory({
    createClient: async () => ({
      async query(text: string, values?: unknown[]) {
        if (text.includes("app_mobile_identities")) {
          const rows = values?.length
            ? identities.filter((i) => i.app_id === values[0])
            : identities;
          return { rows };
        }
        throw new Error("past the gate: the database was reached");
      },
      async end() {},
    }),
  });
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
  ssmMock.on(GetParameterCommand).callsFake(async (input: { Name: string }) => {
    const value = parameters.get(input.Name);
    if (value !== undefined) return { Parameter: { Value: value } };
    if (input.Name.startsWith("/teststack/app-creds/")) {
      return { Parameter: { Value: JSON.stringify({ hmacSecret: "s" }) } };
    }
    throw new ParameterNotFound({ message: "not found", $metadata: {} });
  });
  ssmMock
    .on(PutParameterCommand)
    .callsFake(async (input: { Name: string; Value: string; Overwrite?: boolean }) => {
      if (parameters.has(input.Name) && !input.Overwrite) {
        throw new ParameterAlreadyExists({ message: "exists", $metadata: {} });
      }
      parameters.set(input.Name, input.Value);
      return {};
    });
});

function event(args: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): APIGatewayEvent {
  return {
    rawPath: args.path,
    requestContext: { http: { method: args.method } },
    headers: args.headers ?? {},
    ...(args.body !== undefined ? { body: args.body } : {}),
  };
}

function errorOf(res: { body: string }): string {
  return (JSON.parse(res.body) as { error: string }).error;
}

/** Register a key, as the phone does right after signing in. */
async function register(
  token: string,
  claims: Partial<Parameters<typeof authority.chain>[0]> = {},
): Promise<{ status: number; body: Record<string, unknown>; key: KeyPair }> {
  const challenge = createHash("sha256").update(token).digest();
  const { chain, key } = authority.chain({ challenge, ...claims });
  const res = await handler(
    event({
      method: "POST",
      path: "/apps/starkeep-drive/mobile/keys",
      headers: { "X-Starkeep-User-Token": token },
      body: JSON.stringify({ chain: chain.map((c) => c.toString("base64")) }),
    }),
    context,
  );
  return { status: res.statusCode, body: JSON.parse(res.body), key };
}

/** The headers a phone sends with a signed request. */
function signed(
  token: string,
  keyId: string,
  key: KeyPair,
  req: { method: string; appId?: string; subPath: string; body?: string; ts?: number },
): Record<string, string> {
  const ts = req.ts ?? Date.now();
  const message = mobileSignedMessage(
    req.appId ?? "starkeep-drive",
    req.method,
    req.subPath,
    ts,
    Buffer.from(req.body ?? "", "utf8"),
  );
  return {
    "X-Starkeep-User-Token": token,
    "X-Starkeep-Key-Id": keyId,
    "X-Starkeep-Key-Sig": sign("sha256", message, key.privateKey).toString("base64"),
    "X-Starkeep-App-Ts": String(ts),
  };
}

describe("registering an attested key", () => {
  it("registers a key attested to an app's declared build, for the token's user", async () => {
    const token = await mobileToken();
    const { status, body, key } = await register(token);
    expect(status).toBe(200);
    expect(body.appId).toBe("photos");
    const spki = key.publicKey.export({ type: "spki", format: "der" });
    expect(body.keyId).toBe(createHash("sha256").update(spki).digest("hex"));
    const stored = JSON.parse(parameters.get(`/teststack/platform/mobile-keys/${body.keyId}`)!);
    expect(stored).toMatchObject({ userId: "test-user", appId: "photos" });
  });

  it("registers the same key again idempotently", async () => {
    const token = await mobileToken();
    const first = await register(token);
    const again = await register(token, { key: first.key });
    expect(again.status).toBe(200);
  });

  const refusals: Array<[string, Partial<Parameters<typeof authority.chain>[0]>]> = [
    ["a wrong challenge", { challenge: Buffer.alloc(32, 9) }],
    ["an unknown package", { packageName: "com.evil.photos" }],
    ["a wrong certificate digest", { certDigests: ["ab".repeat(32)] }],
    ["a software-level key", { securityLevel: SecurityLevel.software }],
    ["an unlocked device", { deviceLocked: false }],
  ];
  for (const [label, claims] of refusals) {
    it(`refuses ${label}`, async () => {
      const { status } = await register(await mobileToken(), claims);
      expect(status).toBe(403);
      expect(parameters.size).toBe(0);
    });
  }

  it("refuses a revoked certificate", async () => {
    setAttestation([authority.rootPem], new Set(["2"]));
    expect((await register(await mobileToken())).status).toBe(403);
  });

  it("refuses a token from any client but the mobile-apps client", async () => {
    for (const aud of ["test-client-id", "device-client"]) {
      expect((await register(await mobileToken({ aud }))).status, aud).toBe(401);
    }
  });

  it("refuses an app whose mobile build is no longer registered", async () => {
    identities = [];
    expect((await register(await mobileToken())).status).toBe(403);
  });
});

describe("a signed request", () => {
  const EXCHANGE = { method: "POST", subPath: "/sync/exchange", body: "{}" };

  async function registered() {
    const token = await mobileToken();
    const { body, key } = await register(token);
    return { token, keyId: body.keyId as string, key };
  }

  it("passes the gate for Drive's exchange", async () => {
    const { token, keyId, key } = await registered();
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/starkeep-drive/sync/exchange",
        headers: signed(token, keyId, key, EXCHANGE),
        body: "{}",
      }),
      context,
    );
    // Past the gate and the registration check: the exchange reached the database.
    expect(res.statusCode).toBe(500);
  });

  it("refuses a bad signature", async () => {
    const { token, keyId, key } = await registered();
    const headers = signed(token, keyId, key, { ...EXCHANGE, body: '{"other":1}' });
    const res = await handler(
      event({ method: "POST", path: "/apps/starkeep-drive/sync/exchange", headers, body: "{}" }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatch(/signature/);
  });

  it("refuses a stale timestamp", async () => {
    const { token, keyId, key } = await registered();
    const headers = signed(token, keyId, key, { ...EXCHANGE, ts: Date.now() - 10 * 60_000 });
    const res = await handler(
      event({ method: "POST", path: "/apps/starkeep-drive/sync/exchange", headers, body: "{}" }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("refuses a key that belongs to another user", async () => {
    const { keyId, key } = await registered();
    const other = await mobileToken({ sub: "user-b" });
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/starkeep-drive/sync/exchange",
        headers: signed(other, keyId, key, EXCHANGE),
        body: "{}",
      }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("refuses an expired token", async () => {
    const { keyId, key } = await registered();
    const expired = await mobileToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/starkeep-drive/sync/exchange",
        headers: signed(expired, keyId, key, EXCHANGE),
        body: "{}",
      }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("refuses every app's own channel, its attested app's included", async () => {
    const { token, keyId, key } = await registered();
    for (const appId of ["photos", "memo"]) {
      const res = await handler(
        event({
          method: "POST",
          path: `/apps/${appId}/sync/exchange`,
          headers: signed(token, keyId, key, { ...EXCHANGE, appId }),
          body: "{}",
        }),
        context,
      );
      expect(res.statusCode, appId).toBe(403);
    }
  });

  it("never falls back to the device branch when its key is refused", async () => {
    const token = await mobileToken();
    const res = await handler(
      event({
        method: "GET",
        path: "/apps/starkeep-drive/deployment/settings",
        headers: { "X-Starkeep-User-Token": token, "X-Starkeep-Key-Id": "f".repeat(64) },
      }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("refuses a route outside the sync allowlist", async () => {
    const { token, keyId, key } = await registered();
    const res = await handler(
      event({
        method: "DELETE",
        path: "/apps/starkeep-drive/data/records/r1",
        headers: signed(token, keyId, key, { method: "DELETE", subPath: "/data/records/r1" }),
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
  });

  it("stops at once when the app's mobile build is unregistered", async () => {
    const { token, keyId, key } = await registered();
    identities = [];
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/starkeep-drive/sync/exchange",
        headers: signed(token, keyId, key, EXCHANGE),
        body: "{}",
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toMatch(/no longer registered/);
  });
});

describe("a mobile-client token without a key", () => {
  it("is refused on the device branch, whose client differs", async () => {
    process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID = "device-client";
    try {
      const res = await handler(
        event({
          method: "POST",
          path: "/apps/starkeep-drive/sync/exchange",
          headers: { "X-Starkeep-User-Token": await mobileToken() },
          body: "{}",
        }),
        context,
      );
      expect(res.statusCode).toBe(401);
    } finally {
      delete process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID;
    }
  });
});
