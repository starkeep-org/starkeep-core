/**
 * Device-key authentication at the handler's gate.
 *
 * A handset cannot hold a per-app HMAC secret (symmetric, extractable from a
 * distributable APK, unrevocable without breaking every other client), so it
 * signs with an Ed25519 key registered in SSM instead. These tests exercise the
 * gate the way a device will hit it — signing with `@noble/curves`, exactly as
 * `photos-mobile/src/auth/device-key.ts` does, against the handler verifying
 * with `node:crypto`. Two implementations either side of the wire is the point:
 * a test that signed and verified with the same library would prove nothing
 * about the pairing that actually ships.
 *
 * Same harness convention as `handler-auth.test.ts`: AURORA_ENDPOINT points
 * nowhere, so "gate passed" is observable as a 500 from pg connect and "gate
 * rejected" as a 401, with no DSQL involved.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand, ParameterNotFound } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);

const ACCOUNT_ID = "123456789012";
const context: LambdaContext = {
  invokedFunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:teststack-cds`,
};

let handler: (typeof import("../src/api-handler.js"))["handler"];
let deviceMayCall: (typeof import("../src/api-handler.js"))["deviceMayCall"];
let deviceWriteRefusal: (typeof import("../src/api-handler.js"))["deviceWriteRefusal"];

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "invalid.test.localdomain";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.AWS_REGION = "us-east-1";
  // The module caches SSM lookups for 5 minutes by default, which would make
  // every test after the first see a stale device. Each test uses a distinct
  // device id, except where reuse is the point.
  process.env.HMAC_CACHE_TTL_MS = "0";
  vi.spyOn(console, "error").mockImplementation(() => {});
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
});

/** The 12-byte RFC 8410 SPKI prefix for Ed25519, as the phone emits. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function makeDevice() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKey,
    publicKeySpki: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]).toString("base64"),
    /**
     * Byte-for-byte what `device-key.ts` produces.
     *
     * Typed as a header bag rather than left to infer the four keys it happens
     * to return, because callers both add a header to it and assert that a
     * header is absent — and an inferred closed record makes the second a type
     * error rather than the assertion it is.
     */
    sign(
      appId: string,
      method: string,
      path: string,
      body: string | undefined,
      ts = Date.now(),
    ): Record<string, string> {
      const upper = method.toUpperCase();
      const signedBody = upper === "GET" || upper === "HEAD" ? "" : (body ?? "");
      const message = Buffer.concat([
        Buffer.from(`${appId}:${upper}:${path}:${ts}:`, "utf8"),
        Buffer.from(signedBody, "utf8"),
      ]);
      return {
        "X-Starkeep-App-Id": appId,
        "X-Starkeep-App-Ts": String(ts),
        "X-Starkeep-Device-Id": "dev-unset",
        "X-Starkeep-Device-Sig": Buffer.from(
          ed25519.sign(new Uint8Array(message), privateKey),
        ).toString("base64"),
      };
    },
  };
}

/**
 * Register a device and an app, the way admin-web and the installer would.
 * The device may act as `appId` unless `appIds` says otherwise; `null` writes a
 * record with no `appIds` at all, as pairing did before it recorded them.
 */
function scriptRegistered(
  deviceId: string,
  publicKeySpki: string,
  appId: string,
  userId?: string,
  appIds: readonly string[] | null = [appId],
) {
  ssmMock
    .on(GetParameterCommand, { Name: `/teststack/platform/devices/${deviceId}` })
    .resolves({
      Parameter: {
        Value: JSON.stringify({
          publicKeySpki,
          ...(userId ? { userId } : {}),
          ...(appIds ? { appIds } : {}),
        }),
      },
    });
  ssmMock
    .on(GetParameterCommand, { Name: `/teststack/app-creds/${appId}`, WithDecryption: true })
    .resolves({ Parameter: { Value: JSON.stringify({ hmacSecret: "the-app-secret" }) } });
}

/** Register an installed app with no device, for a device that names it. */
function scriptApp(appId: string) {
  ssmMock
    .on(GetParameterCommand, { Name: `/teststack/app-creds/${appId}`, WithDecryption: true })
    .resolves({ Parameter: { Value: JSON.stringify({ hmacSecret: "the-app-secret" }) } });
}

/** Send one signed device request and return the response. */
async function deviceCall(
  device: ReturnType<typeof makeDevice>,
  deviceId: string,
  appId: string,
  method: string,
  path: string,
  body?: string,
) {
  const headers = device.sign(appId, method, path, body);
  headers["X-Starkeep-Device-Id"] = deviceId;
  return handler(
    makeEvent({ method, path: `/apps/${appId}${path}`, headers, ...(body !== undefined ? { body } : {}) }),
    context,
  );
}

function makeEvent(args: {
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

const errorOf = (res: { body: string }) => (JSON.parse(res.body) as { error: string }).error;

describe("a registered device", () => {
  it("passes the gate on a signed GET", async () => {
    const device = makeDevice();
    scriptRegistered("dev-ok-get", device.publicKeySpki, "starkeep-drive");
    const headers = device.sign("starkeep-drive", "GET", "/health", undefined);
    headers["X-Starkeep-Device-Id"] = "dev-ok-get";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/starkeep-drive/health", headers }),
      context,
    );
    // A passed gate falls through to pg connect against a host that does not
    // resolve, so 500 is success here and 401 is the failure being tested for —
    // the same convention `handler-auth.test.ts` uses.
    expect(res.statusCode).toBe(500);
  });

  it("passes the gate on a signed POST with a body", async () => {
    const device = makeDevice();
    scriptRegistered("dev-ok-post", device.publicKeySpki, "starkeep-drive");
    const body = JSON.stringify({ records: [] });
    const headers = device.sign("starkeep-drive", "POST", "/sync/exchange", body);
    headers["X-Starkeep-Device-Id"] = "dev-ok-post";

    const res = await handler(
      makeEvent({ method: "POST", path: "/apps/starkeep-drive/sync/exchange", headers, body }),
      context,
    );
    // Past the gate, into pg connect against a host that does not resolve.
    expect(res.statusCode).toBe(500);
  });

  it("needs no X-Starkeep-User-Token, because the device key already is one", async () => {
    // Every HMAC-signed data-plane call must carry an end-user token, and this
    // one carries none — which reads as an exemption unless it is said out
    // loud that it is not. A device key is issued by the platform at pairing
    // time against a named Cognito user (`scriptRegistered`'s `userId`), so
    // the signature already names the person. Same requirement, other shape.
    const device = makeDevice();
    scriptRegistered("dev-no-usertoken", device.publicKeySpki, "starkeep-drive", "cognito-user-1");
    const headers = device.sign("starkeep-drive", "POST", "/sync/exchange", "{}");
    headers["X-Starkeep-Device-Id"] = "dev-no-usertoken";
    expect(headers["X-Starkeep-User-Token"]).toBeUndefined();

    const res = await handler(
      makeEvent({
        method: "POST",
        path: "/apps/starkeep-drive/sync/exchange",
        headers,
        body: "{}",
      }),
      context,
    );
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(500);
  });
});

describe("a device that should be refused", () => {
  it("401s when the device is not registered", async () => {
    const device = makeDevice();
    ssmMock
      .on(GetParameterCommand)
      .rejects(new ParameterNotFound({ message: "not found", $metadata: {} }));
    const headers = device.sign("starkeep-drive", "GET", "/health", undefined);
    headers["X-Starkeep-Device-Id"] = "dev-unregistered";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/starkeep-drive/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Unknown or revoked device");
  });

  it("401s a revoked device rather than falling back to the app secret", async () => {
    // The property that matters most here. A device whose parameter is gone
    // must be denied outright — never handed a second chance at the shared
    // HMAC path, which is the credential it must not have.
    const device = makeDevice();
    ssmMock
      .on(GetParameterCommand, { Name: "/teststack/platform/devices/dev-revoked" })
      .rejects(new ParameterNotFound({ message: "gone", $metadata: {} }));
    ssmMock
      .on(GetParameterCommand, { Name: "/teststack/app-creds/starkeep-drive", WithDecryption: true })
      .resolves({ Parameter: { Value: JSON.stringify({ hmacSecret: "the-app-secret" }) } });

    const headers = device.sign("starkeep-drive", "GET", "/health", undefined);
    headers["X-Starkeep-Device-Id"] = "dev-revoked";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/starkeep-drive/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("401s a signature made by a different key", async () => {
    const registered = makeDevice();
    const impostor = makeDevice();
    scriptRegistered("dev-impostor", registered.publicKeySpki, "starkeep-drive");
    const headers = impostor.sign("starkeep-drive", "GET", "/health", undefined);
    headers["X-Starkeep-Device-Id"] = "dev-impostor";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/starkeep-drive/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Invalid device signature");
  });

  it("401s a signature captured for a different path", async () => {
    const device = makeDevice();
    scriptRegistered("dev-replay-path", device.publicKeySpki, "starkeep-drive");
    const headers = device.sign("starkeep-drive", "GET", "/health", undefined);
    headers["X-Starkeep-Device-Id"] = "dev-replay-path";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/starkeep-drive/sync/state", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("401s a signature replayed against a different channel", async () => {
    const device = makeDevice();
    scriptRegistered("dev-replay-app", device.publicKeySpki, "photos");
    // Signed for starkeep-drive, presented as photos.
    const headers = device.sign("starkeep-drive", "GET", "/health", undefined);
    headers["X-Starkeep-Device-Id"] = "dev-replay-app";
    headers["X-Starkeep-App-Id"] = "photos";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/photos/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("401s a tampered body", async () => {
    const device = makeDevice();
    scriptRegistered("dev-tamper", device.publicKeySpki, "starkeep-drive");
    const body = JSON.stringify({ records: [] });
    const headers = device.sign("starkeep-drive", "POST", "/sync/exchange", body);
    headers["X-Starkeep-Device-Id"] = "dev-tamper";

    const res = await handler(
      makeEvent({
        method: "POST",
        path: "/apps/starkeep-drive/sync/exchange",
        headers,
        body: JSON.stringify({ records: [{ id: "injected" }] }),
      }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });

  it("401s a stale timestamp, bounding replay", async () => {
    const device = makeDevice();
    scriptRegistered("dev-stale", device.publicKeySpki, "starkeep-drive");
    const headers = device.sign(
      "starkeep-drive",
      "GET",
      "/health",
      undefined,
      Date.now() - 10 * 60_000,
    );
    headers["X-Starkeep-Device-Id"] = "dev-stale";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/starkeep-drive/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Stale or invalid signature timestamp");
  });

  it("401s an app the device names but that is not installed", async () => {
    const device = makeDevice();
    ssmMock
      .on(GetParameterCommand, { Name: "/teststack/platform/devices/dev-ghostapp" })
      .resolves({ Parameter: { Value: JSON.stringify({ publicKeySpki: device.publicKeySpki }) } });
    ssmMock
      .on(GetParameterCommand, { Name: "/teststack/app-creds/ghost", WithDecryption: true })
      .rejects(new ParameterNotFound({ message: "not found", $metadata: {} }));

    const headers = device.sign("ghost", "GET", "/health", undefined);
    headers["X-Starkeep-Device-Id"] = "dev-ghostapp";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/ghost/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Unknown app: ghost");
  });
});

describe("device ids are used to build a parameter name, so they are constrained", () => {
  it("401s a device id containing path traversal, without querying SSM for it", async () => {
    // Unconstrained, `../` would turn a signature check into a probe for
    // arbitrary parameters — including the app secrets one level up.
    const device = makeDevice();
    const headers = device.sign("starkeep-drive", "GET", "/health", undefined);
    headers["X-Starkeep-Device-Id"] = "../starkeep-drive";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/starkeep-drive/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Unknown or revoked device");
    expect(
      ssmMock.calls().some((c) => JSON.stringify(c.args[0].input).includes("..")),
    ).toBe(false);
  });

  it("401s a device id with a slash in it", async () => {
    const device = makeDevice();
    const headers = device.sign("starkeep-drive", "GET", "/health", undefined);
    headers["X-Starkeep-Device-Id"] = "a/b";

    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/starkeep-drive/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
  });
});

describe("the HMAC path is untouched", () => {
  it("still verifies a server-to-server call with no device headers", async () => {
    const { signRequest } = await import("@starkeep/app-client");
    ssmMock
      .on(GetParameterCommand, { Name: "/teststack/app-creds/local-server", WithDecryption: true })
      .resolves({ Parameter: { Value: JSON.stringify({ hmacSecret: "shared" }) } });

    const signed = signRequest({
      appId: "local-server",
      hmacSecret: "shared",
      method: "GET",
      path: "/health",
    });
    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/local-server/health", headers: signed }),
      context,
    );
    // 500, not 401: the HMAC gate still passes and hands off to the DB.
    expect(res.statusCode).toBe(500);
  });
});

describe("a device acts only as the apps it was paired for", () => {
  it("403s an installed app the device was not paired for", async () => {
    // Before pairing recorded app ids, a device key was a key to every
    // installed app. A phone needs Starkeep Drive and nothing else.
    const device = makeDevice();
    scriptRegistered("dev-drive-only", device.publicKeySpki, "starkeep-drive");
    scriptApp("photos");

    const res = await deviceCall(device, "dev-drive-only", "photos", "GET", "/health");
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toMatch(/may act only as starkeep-drive, not photos/);
  });

  it("403s every app for a record written before pairing recorded app ids", async () => {
    const device = makeDevice();
    scriptRegistered("dev-no-appids", device.publicKeySpki, "starkeep-drive", undefined, null);

    const res = await deviceCall(device, "dev-no-appids", "starkeep-drive", "GET", "/health");
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toMatch(/may act only as no app/);
  });

  it("ignores app ids that are not strings", async () => {
    const device = makeDevice();
    ssmMock
      .on(GetParameterCommand, { Name: "/teststack/platform/devices/dev-junk-appids" })
      .resolves({
        Parameter: {
          Value: JSON.stringify({ publicKeySpki: device.publicKeySpki, appIds: [7, "starkeep-drive"] }),
        },
      });
    scriptApp("starkeep-drive");

    const res = await deviceCall(device, "dev-junk-appids", "starkeep-drive", "GET", "/health");
    expect(res.statusCode).toBe(500);
  });
});

describe("a device reaches only the routes the phone calls", () => {
  const KEY = "shared/image/ab/abcdef0123456789";

  it.each([
    ["GET", "/health", undefined],
    ["POST", "/sync/exchange", JSON.stringify({ watermarks: {}, records: [] })],
    ["POST", "/files/presign", JSON.stringify({ key: KEY })],
    ["GET", `/files/${KEY}/presign`, undefined],
    ["GET", `/files/${KEY}/stat`, undefined],
    ["HEAD", `/files/${KEY}`, undefined],
  ])("lets %s %s through the gate", async (method, path, body) => {
    const device = makeDevice();
    const id = `dev-allow-${method}-${path.length}`;
    scriptRegistered(id, device.publicKeySpki, "starkeep-drive");
    const res = await deviceCall(device, id, "starkeep-drive", method, path, body);
    // Past the gate, into pg connect against a host that does not resolve.
    expect(res.statusCode).toBe(500);
  });

  it.each([
    ["GET", "/data/records", undefined],
    ["POST", "/data/records", JSON.stringify({ type: "image/jpeg" })],
    ["DELETE", "/data/records/rec-1", undefined],
    ["POST", "/data/records/rec-1/restore", "{}"],
    ["DELETE", `/files/${KEY}`, undefined],
    ["POST", "/data/labels", "{}"],
    ["POST", "/data/reap", "{}"],
    ["GET", "/app-data/db/captions", undefined],
  ])("403s %s %s", async (method, path, body) => {
    const device = makeDevice();
    const id = `dev-deny-${method}-${path.length}`;
    scriptRegistered(id, device.publicKeySpki, "starkeep-drive");
    const res = await deviceCall(device, id, "starkeep-drive", method, path, body);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toBe(`A paired device may not call ${method} ${path}`);
  });

  it("checks the route only after the signature, so an impostor learns nothing about it", async () => {
    const registered = makeDevice();
    const impostor = makeDevice();
    scriptRegistered("dev-route-impostor", registered.publicKeySpki, "starkeep-drive");
    const res = await deviceCall(impostor, "dev-route-impostor", "starkeep-drive", "DELETE", "/data/records/x");
    expect(res.statusCode).toBe(401);
  });
});

describe("a device may not write the platform's own files", () => {
  const settingsRecord = {
    id: "settings-1",
    type: "starkeep/settings",
    createdAt: "0000000000001-0000-node",
    updatedAt: "0000000000001-0000-node",
  };

  it("403s an exchange that carries a settings record", async () => {
    const device = makeDevice();
    scriptRegistered("dev-push-settings", device.publicKeySpki, "starkeep-drive");
    const body = JSON.stringify({ watermarks: {}, records: [settingsRecord] });
    const res = await deviceCall(device, "dev-push-settings", "starkeep-drive", "POST", "/sync/exchange", body);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res)).toBe("A paired device may not write the platform's own files");
  });

  it("403s an exchange that carries a tombstone of a settings record", async () => {
    // Tombstoning the winning file reverts every setting to the defaults.
    const device = makeDevice();
    scriptRegistered("dev-tomb-settings", device.publicKeySpki, "starkeep-drive");
    const body = JSON.stringify({
      watermarks: {},
      records: [{ id: "img-1", type: "image/jpeg" }, { ...settingsRecord, deletedAt: settingsRecord.updatedAt }],
    });
    const res = await deviceCall(device, "dev-tomb-settings", "starkeep-drive", "POST", "/sync/exchange", body);
    expect(res.statusCode).toBe(403);
  });

  it("lets an exchange of ordinary records through", async () => {
    const device = makeDevice();
    scriptRegistered("dev-push-photo", device.publicKeySpki, "starkeep-drive");
    const body = JSON.stringify({ watermarks: {}, records: [{ id: "img-1", type: "image/jpeg" }] });
    const res = await deviceCall(device, "dev-push-photo", "starkeep-drive", "POST", "/sync/exchange", body);
    expect(res.statusCode).toBe(500);
  });

  it("403s a presigned upload into the platform category", async () => {
    const device = makeDevice();
    scriptRegistered("dev-presign-settings", device.publicKeySpki, "starkeep-drive");
    const body = JSON.stringify({ key: "shared/starkeep/ab/abcdef0123456789" });
    const res = await deviceCall(device, "dev-presign-settings", "starkeep-drive", "POST", "/files/presign", body);
    expect(res.statusCode).toBe(403);
  });

  it("leaves a body that does not parse to the route, which refuses it", () => {
    expect(deviceWriteRefusal("POST", "/sync/exchange", Buffer.from("{not json"))).toBeNull();
  });
});

describe("deviceMayCall", () => {
  it("does not match a path that merely starts like an allowed one", () => {
    expect(deviceMayCall("POST", "/sync/exchange/extra")).toBe(false);
    expect(deviceMayCall("GET", "/healthz")).toBe(false);
    expect(deviceMayCall("GET", "/files/presign")).toBe(false);
    expect(deviceMayCall("PUT", "/files/shared/image/ab/cd")).toBe(false);
    expect(deviceMayCall("GET", "/files/shared/image/ab/cd")).toBe(false);
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

  it("ignores records with no type, such as app-syncable rows", () => {
    const body = Buffer.from(JSON.stringify({ records: [{ id: "x" }, null, 3] }));
    expect(deviceWriteRefusal("POST", "/sync/exchange", body)).toBeNull();
  });
});
