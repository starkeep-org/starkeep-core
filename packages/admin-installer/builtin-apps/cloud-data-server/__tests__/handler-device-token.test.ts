/**
 * The device-token branch: a signed-in desktop or phone presents its ID token
 * and nothing else.
 *
 * What makes a bare token safe is the client that issued it. Cloud app Lambdas
 * hold users' tokens from the admin client and are untrusted code, so a token
 * from any client but the device client must not pass here — otherwise every
 * app a person signs in to could act as Drive for them. Most of these cases are
 * that one property from different angles.
 *
 * Same harness convention as `handler-auth.test.ts`: AURORA_ENDPOINT points
 * nowhere, so "gate passed" is observable as a 500 from pg connect and "gate
 * rejected" as a 401 or 403, with no DSQL involved.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand, ParameterNotFound } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { signRequest } from "@starkeep/app-client";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import {
  installUserTokenFixture,
  mintTestUserToken,
  TEST_POOL_ID,
  TEST_REGION,
} from "./user-token.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);

const ACCOUNT_ID = "123456789012";
const context: LambdaContext = {
  invokedFunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:teststack-cds`,
};

const DEVICE_CLIENT_ID = "test-device-client";

let handler: (typeof import("../src/api-handler.js"))["handler"];
let deviceMayCall: (typeof import("../src/api-handler.js"))["deviceMayCall"];
let deviceWriteRefusal: (typeof import("../src/api-handler.js"))["deviceWriteRefusal"];

/** A token from the device client, for a user in the data group. */
function deviceToken(over: Record<string, unknown> = {}): Promise<string> {
  return mintTestUserToken({
    aud: DEVICE_CLIENT_ID,
    "cognito:groups": ["starkeep-users"],
    ...over,
  });
}

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "invalid.test.localdomain";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.HMAC_CACHE_TTL_MS = "0";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await installUserTokenFixture();
  process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID = DEVICE_CLIENT_ID;
  ({ handler, deviceMayCall, deviceWriteRefusal } = await import("../src/api-handler.js"));
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
  for (const appId of ["starkeep-drive", "photos"]) {
    ssmMock
      .on(GetParameterCommand, { Name: `/teststack/app-creds/${appId}`, WithDecryption: true })
      .resolves({ Parameter: { Value: JSON.stringify({ hmacSecret: `${appId}-secret` }) } });
  }
});

function event(args: {
  method: string;
  path: string;
  token?: string;
  headers?: Record<string, string>;
  body?: string;
}): APIGatewayEvent {
  return {
    rawPath: args.path,
    requestContext: { http: { method: args.method } },
    headers: {
      ...(args.token !== undefined ? { "X-Starkeep-User-Token": args.token } : {}),
      ...(args.headers ?? {}),
    },
    ...(args.body !== undefined ? { body: args.body } : {}),
  };
}

function errorOf(res: { body: string }): string {
  return (JSON.parse(res.body) as { error: string }).error;
}

const EXCHANGE = { method: "POST", path: "/apps/starkeep-drive/sync/exchange", body: "{}" };

describe("the discovery route", () => {
  it("tells a device how to sign in, with no credential", async () => {
    const res = await handler(event({ method: "GET", path: "/auth/config" }), context);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      region: TEST_REGION,
      userPoolId: TEST_POOL_ID,
      deviceClientId: DEVICE_CLIENT_ID,
    });
  });

  it("adds the sign-in page and the mobile-apps client once the cloud has them", async () => {
    process.env.STARKEEP_MOBILE_USER_POOL_CLIENT_ID = "test-mobile-client";
    process.env.STARKEEP_COGNITO_DOMAIN = "teststack-1.auth.us-east-1.amazoncognito.com";
    try {
      const res = await handler(event({ method: "GET", path: "/auth/config" }), context);
      expect(JSON.parse(res.body)).toEqual({
        region: TEST_REGION,
        userPoolId: TEST_POOL_ID,
        deviceClientId: DEVICE_CLIENT_ID,
        mobileClientId: "test-mobile-client",
        cognitoDomain: "teststack-1.auth.us-east-1.amazoncognito.com",
      });
    } finally {
      delete process.env.STARKEEP_MOBILE_USER_POOL_CLIENT_ID;
      delete process.env.STARKEEP_COGNITO_DOMAIN;
    }
  });

  it("says so when the deployment has no device client", async () => {
    const saved = process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID;
    delete process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID;
    try {
      const res = await handler(event({ method: "GET", path: "/auth/config" }), context);
      expect(res.statusCode).toBe(503);
    } finally {
      process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID = saved;
    }
  });
});

describe("a device token", () => {
  it("passes the gate for Drive's exchange", async () => {
    const res = await handler(event({ ...EXCHANGE, token: await deviceToken() }), context);
    // Past the gate: the request reached the database, which does not exist here.
    expect(res.statusCode).toBe(500);
  });

  it("acts as any cloud-installed app, as a desktop does", async () => {
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/photos/sync/exchange",
        body: "{}",
        token: await deviceToken(),
      }),
      context,
    );
    expect(res.statusCode).toBe(500);
  });

  it("acts for the token's own user, in that user's S3 session", async () => {
    await handler(event({ ...EXCHANGE, token: await deviceToken({ sub: "member-1" }) }), context);
    const tags = stsMock.commandCalls(AssumeRoleCommand).map((c) => c.args[0].input.Tags);
    expect(tags).toContainEqual([{ Key: "starkeep:userId", Value: "member-1" }]);
  });

  it("is refused for an app that is not installed in the cloud", async () => {
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/ghost/sync/exchange",
        body: "{}",
        token: await deviceToken(),
      }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Unknown app: ghost");
  });

  it("is refused on a route outside the sync routes", async () => {
    const res = await handler(
      event({
        method: "DELETE",
        path: "/apps/starkeep-drive/data/records/r1",
        token: await deviceToken(),
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
  });

  it("may not write the platform's own files", async () => {
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/starkeep-drive/sync/exchange",
        body: JSON.stringify({ records: [{ type: "starkeep/settings" }] }),
        token: await deviceToken(),
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toBe("A device may not write the platform's own files");
  });

  it("may not tombstone the platform's own files either", async () => {
    // Tombstoning the winning settings file reverts every setting to the defaults.
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/starkeep-drive/sync/exchange",
        body: JSON.stringify({
          records: [
            { id: "img-1", type: "image/jpeg" },
            { id: "s-1", type: "starkeep/settings", deletedAt: "t" },
          ],
        }),
        token: await deviceToken(),
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
  });

  it("may not presign an upload into the platform category", async () => {
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/starkeep-drive/files/presign",
        body: JSON.stringify({ key: "shared/test-user/starkeep/ab/abcdef0123456789" }),
        token: await deviceToken(),
      }),
      context,
    );
    expect(res.statusCode).toBe(403);
  });

  it("pushes ordinary records past the gate", async () => {
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/starkeep-drive/sync/exchange",
        body: JSON.stringify({ records: [{ id: "img-1", type: "image/jpeg" }] }),
        token: await deviceToken(),
      }),
      context,
    );
    expect(res.statusCode).toBe(500);
  });

  it("is refused for an account outside the data group", async () => {
    const res = await handler(
      event({ ...EXCHANGE, token: await deviceToken({ "cognito:groups": ["starkeep-admins"] }) }),
      context,
    );
    expect(res.statusCode).toBe(403);
  });

  it("is refused once expired", async () => {
    const res = await handler(
      event({ ...EXCHANGE, token: await deviceToken({ exp: Math.floor(Date.now() / 1000) - 10 }) }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("is refused when it is an access token rather than an ID token", async () => {
    const res = await handler(
      event({ ...EXCHANGE, token: await deviceToken({ token_use: "access" }) }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("is refused when device sign-in is not set up on this cloud", async () => {
    const saved = process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID;
    delete process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID;
    try {
      const res = await handler(event({ ...EXCHANGE, token: await deviceToken() }), context);
      expect(res.statusCode).toBe(401);
    } finally {
      process.env.STARKEEP_DEVICE_USER_POOL_CLIENT_ID = saved;
    }
  });
});

describe("a device token, beyond the sync routes", () => {
  it("reads the deployment's settings, as a desktop and a phone need for their stamps", async () => {
    // The local data server and the phone both read the settings with the
    // token alone once signed in. No parameter is set here, so the answer is
    // the empty document rather than a refusal.
    const res = await handler(
      event({
        method: "GET",
        path: "/apps/starkeep-drive/deployment/settings",
        token: await deviceToken(),
      }),
      context,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ settings: null });
  });

  it("is refused when its issuer names another pool, though it carries the device client's id", async () => {
    // A client id is public, so another deployment's pool can issue a token
    // whose `aud` matches. The issuer is what ties the token to this pool.
    const res = await handler(
      event({
        ...EXCHANGE,
        token: await deviceToken({
          iss: `https://cognito-idp.${TEST_REGION}.amazonaws.com/${TEST_REGION}_OTHERPOOL`,
        }),
      }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });
});

describe("deviceMayCall", () => {
  it("lets a device read the deployment's settings, and nothing else under that path", () => {
    expect(deviceMayCall("GET", "/deployment/settings")).toBe(true);
    expect(deviceMayCall("PUT", "/deployment/settings")).toBe(false);
    expect(deviceMayCall("GET", "/deployment/settings/extra")).toBe(false);
  });

  it("does not match a path that merely starts like an allowed one", () => {
    expect(deviceMayCall("POST", "/sync/exchange/extra")).toBe(false);
    expect(deviceMayCall("GET", "/healthz")).toBe(false);
    expect(deviceMayCall("GET", "/files/presign")).toBe(false);
    expect(deviceMayCall("PUT", "/files/shared/image/ab/cd")).toBe(false);
    expect(deviceMayCall("GET", "/files/shared/image/ab/cd")).toBe(false);
  });

  it("asks about a batch of uploads in one request", () => {
    expect(deviceMayCall("POST", "/files/presign-batch")).toBe(true);
    expect(deviceMayCall("GET", "/files/presign-batch")).toBe(false);
  });

  it("sends a large file as a multipart upload, and nothing else under that path", () => {
    expect(deviceMayCall("POST", "/files/multipart/presign")).toBe(true);
    expect(deviceMayCall("POST", "/files/multipart/complete")).toBe(true);
    expect(deviceMayCall("POST", "/files/multipart/abort")).toBe(false);
  });

  it("reads the cloud's record listing, read-only", () => {
    expect(deviceMayCall("GET", "/data/records")).toBe(true);
    expect(deviceMayCall("GET", "/data/types")).toBe(true);
    expect(deviceMayCall("POST", "/data/records")).toBe(false);
    expect(deviceMayCall("DELETE", "/data/records/abc")).toBe(false);
  });
});

describe("deviceWriteRefusal", () => {
  it("reads nothing on routes that carry no write", () => {
    expect(deviceWriteRefusal("GET", "/health", Buffer.from("[]"))).toBeNull();
    expect(deviceWriteRefusal("HEAD", "/files/shared/starkeep/ab/cd", Buffer.alloc(0))).toBeNull();
  });

  it("refuses by category, not by the one settings type", () => {
    const body = Buffer.from(JSON.stringify({ records: [{ type: "starkeep/some-future-file" }] }));
    expect(deviceWriteRefusal("POST", "/sync/exchange", body)).not.toBeNull();
  });

  it("refuses a multipart upload of a platform file as it refuses a single PUT", () => {
    const body = Buffer.from(JSON.stringify({ key: "shared/u/starkeep/ab/cd" }));
    for (const route of [
      "/files/presign",
      "/files/multipart/presign",
      "/files/multipart/complete",
    ]) {
      expect(deviceWriteRefusal("POST", route, body), route).not.toBeNull();
    }
  });

  it("refuses a batch that names a platform file in any item, by key or by type", () => {
    const byKey = Buffer.from(
      JSON.stringify({
        items: [{ key: "shared/u/image/ab/cd" }, { key: "shared/u/starkeep/ab/cd" }],
      }),
    );
    expect(deviceWriteRefusal("POST", "/files/presign-batch", byKey)).not.toBeNull();
    const byType = Buffer.from(JSON.stringify({ type: "starkeep/settings", contentHash: "ab" }));
    expect(deviceWriteRefusal("POST", "/files/presign", byType)).not.toBeNull();
    const ordinary = Buffer.from(JSON.stringify({ items: [{ key: "shared/u/image/ab/cd" }] }));
    expect(deviceWriteRefusal("POST", "/files/presign-batch", ordinary)).toBeNull();
  });

  it("ignores records with no type, such as app-syncable rows", () => {
    const body = Buffer.from(JSON.stringify({ records: [{ id: "x" }, null, 3] }));
    expect(deviceWriteRefusal("POST", "/sync/exchange", body)).toBeNull();
  });

  it("leaves a body that does not parse to the route, which refuses it", () => {
    expect(deviceWriteRefusal("POST", "/sync/exchange", Buffer.from("{not json"))).toBeNull();
  });
});

describe("a token from another client", () => {
  it("cannot act as a device: an admin-client token without an HMAC is refused", async () => {
    // The attack the client split exists for. A cloud app's Lambda holds this
    // token for every user who signs in to the app; sent bare, it must not act
    // as Drive.
    const appHeldToken = await mintTestUserToken({ "cognito:groups": ["starkeep-users"] });
    const res = await handler(event({ ...EXCHANGE, token: appHeldToken }), context);
    expect(res.statusCode).toBe(401);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });
});

describe("a device token on the HMAC branch", () => {
  it("does not work as a cloud app session", async () => {
    // Signed as Photos with Photos' own secret, so the HMAC passes; the token
    // beside it is a device token, which the HMAC branch never accepts.
    const body = "{}";
    const signed = signRequest({
      appId: "photos",
      hmacSecret: "photos-secret",
      method: "POST",
      path: "/sync/exchange",
      body,
    });
    const res = await handler(
      event({
        method: "POST",
        path: "/apps/photos/sync/exchange",
        body,
        headers: signed,
        token: await deviceToken(),
      }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Invalid or expired end-user token");
  });
});
