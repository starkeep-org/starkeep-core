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
  ({ handler } = await import("../src/api-handler.js"));
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
    /** Byte-for-byte what `device-key.ts` produces. */
    sign(appId: string, method: string, path: string, body: string | undefined, ts = Date.now()) {
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

/** Register a device and an app, the way admin-web and the installer would. */
function scriptRegistered(deviceId: string, publicKeySpki: string, appId: string, userId?: string) {
  ssmMock
    .on(GetParameterCommand, {
      Name: `/teststack/app-creds/_device-${deviceId}`,
      WithDecryption: true,
    })
    .resolves({
      Parameter: { Value: JSON.stringify({ publicKeySpki, ...(userId ? { userId } : {}) }) },
    });
  ssmMock
    .on(GetParameterCommand, { Name: `/teststack/app-creds/${appId}`, WithDecryption: true })
    .resolves({ Parameter: { Value: JSON.stringify({ hmacSecret: "the-app-secret" }) } });
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
      .on(GetParameterCommand, {
        Name: "/teststack/app-creds/_device-dev-revoked",
        WithDecryption: true,
      })
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
      .on(GetParameterCommand, {
        Name: "/teststack/app-creds/_device-dev-ghostapp",
        WithDecryption: true,
      })
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
