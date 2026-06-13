/**
 * Handler auth-gate tests (plan §10, Tier 0/1 slice — no DB fake).
 *
 * SSM and STS are mocked with aws-sdk-client-mock; AURORA_ENDPOINT points at a
 * non-resolvable host so any request that passes the HMAC + AssumeRole gate
 * fails fast at pg connect with a 500. That makes "gate passed" observable as
 * `statusCode === 500` (vs 401 for a rejected gate) without standing up DSQL.
 *
 * The handler's module-level caches (HMAC secrets, STS creds) persist across
 * tests in this file — every case uses a distinct appId except the two cache
 * tests, which rely on reuse deliberately.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand, ParameterNotFound } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { signRequest } from "@starkeep/app-client";
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
  // Expected 500s log "Handler error:" — keep test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handler } = await import("../src/api-handler.js"));
});

beforeEach(() => {
  ssmMock.reset();
  stsMock.reset();
});

function scriptSecret(appId: string, hmacSecret: string) {
  ssmMock
    .on(GetParameterCommand, { Name: `/teststack/app-creds/${appId}`, WithDecryption: true })
    .resolves({ Parameter: { Value: JSON.stringify({ hmacSecret }) } });
}

function scriptAssumeRole() {
  stsMock.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: "AKIAFAKE",
      SecretAccessKey: "fake-secret",
      SessionToken: "fake-token",
      Expiration: new Date(Date.now() + 900_000),
    },
  });
}

function makeEvent(args: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}): APIGatewayEvent {
  return {
    rawPath: args.path,
    requestContext: { http: { method: args.method } },
    headers: args.headers ?? {},
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.isBase64Encoded !== undefined ? { isBase64Encoded: args.isBase64Encoded } : {}),
  };
}

function errorOf(res: { body: string }): string {
  return (JSON.parse(res.body) as { error: string }).error;
}

describe("unauthenticated routes", () => {
  it("GET /health returns 200 without consulting SSM", async () => {
    const res = await handler(makeEvent({ method: "GET", path: "/health" }), context);
    expect(res.statusCode).toBe(200);
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it("OPTIONS returns 200", async () => {
    const res = await handler(makeEvent({ method: "OPTIONS", path: "/apps/whatever" }), context);
    expect(res.statusCode).toBe(200);
  });

  it("paths outside /apps/{appId} return 404", async () => {
    const res = await handler(makeEvent({ method: "GET", path: "/nope" }), context);
    expect(res.statusCode).toBe(404);
  });
});

describe("HMAC gate", () => {
  it("401s an app with no SSM credential parameter", async () => {
    ssmMock
      .on(GetParameterCommand)
      .rejects(new ParameterNotFound({ message: "not found", $metadata: {} }));
    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/ghost-app/health" }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Unknown app: ghost-app");
  });

  it("401s requests missing the signature headers", async () => {
    scriptSecret("app-nohdr", "secret-nohdr");
    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/app-nohdr/health" }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toMatch(/Missing X-Starkeep-App/);
    expect(stsMock.calls()).toHaveLength(0);
  });

  it("401s a header appId that does not match the path, without assuming a role", async () => {
    scriptSecret("app-mismatch", "secret-mismatch");
    const headers = signRequest({ appId: "other-app", hmacSecret: "secret-mismatch" });
    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/app-mismatch/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Header appId does not match path");
    expect(stsMock.calls()).toHaveLength(0);
  });

  it("401s a signature made with the wrong secret", async () => {
    scriptSecret("app-badsig", "the-real-secret");
    const headers = signRequest({ appId: "app-badsig", hmacSecret: "some-other-secret" });
    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/app-badsig/health", headers }),
      context,
    );
    expect(res.statusCode).toBe(401);
    expect(errorOf(res)).toBe("Invalid signature");
  });

  it("passes a valid GET signature and assumes the per-app role", async () => {
    scriptSecret("app-valid", "secret-valid");
    scriptAssumeRole();
    // GET signs over the empty body on both sides (sign.ts / validateAppHmac).
    const headers = signRequest({ appId: "app-valid", hmacSecret: "secret-valid" });
    const res = await handler(
      makeEvent({ method: "GET", path: "/apps/app-valid/health", headers }),
      context,
    );
    // Gate passed; the request then dies at the unresolvable Aurora endpoint.
    expect(res.statusCode).toBe(500);
    const assumeCalls = stsMock.commandCalls(AssumeRoleCommand);
    expect(assumeCalls).toHaveLength(1);
    expect(assumeCalls[0]!.args[0].input.RoleArn).toBe(
      `arn:aws:iam::${ACCOUNT_ID}:role/teststack-app-app-valid-role`,
    );
  });

  it("verifies base64-encoded bodies against the decoded bytes", async () => {
    scriptSecret("app-b64", "secret-b64");
    scriptAssumeRole();
    const bodyBytes = Buffer.from(JSON.stringify({ hello: "wörld" }), "utf8");
    const headers = signRequest({ appId: "app-b64", hmacSecret: "secret-b64", body: bodyBytes });
    const res = await handler(
      makeEvent({
        method: "POST",
        path: "/apps/app-b64/data/records",
        headers,
        body: bodyBytes.toString("base64"),
        isBase64Encoded: true,
      }),
      context,
    );
    expect(res.statusCode).toBe(500); // gate passed (≠ 401), failed at DSQL connect
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });
});

describe("warm-instance caches", () => {
  it("fetches the HMAC secret from SSM once per app within the TTL", async () => {
    // Pins the current stale-after-reinstall window (doc 27 / todo 16): a
    // reinstalled app's new secret is not seen until the 5-min TTL lapses.
    scriptSecret("app-cache", "secret-cache");
    scriptAssumeRole();
    const headers = signRequest({ appId: "app-cache", hmacSecret: "secret-cache" });
    const event = makeEvent({ method: "GET", path: "/apps/app-cache/health", headers });
    expect((await handler(event, context)).statusCode).toBe(500);
    expect((await handler(event, context)).statusCode).toBe(500);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  it("assumes the per-app role once per app while the session is fresh", async () => {
    scriptSecret("app-stscache", "secret-stscache");
    scriptAssumeRole();
    const headers = signRequest({ appId: "app-stscache", hmacSecret: "secret-stscache" });
    const event = makeEvent({ method: "GET", path: "/apps/app-stscache/health", headers });
    expect((await handler(event, context)).statusCode).toBe(500);
    expect((await handler(event, context)).statusCode).toBe(500);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });
});
