/**
 * Route-level tests for the six capability routes on the buffered handler, and
 * for the two pieces of glue that live only in `api-handler.ts` and therefore
 * can't be reached from the handler-module unit tests:
 *
 *  - `makeCapabilityContentReader` — the by-reference authorization path. The
 *    app-role HEAD is the load-bearing readability proof, `parseObjectKey` is a
 *    belt over the record-derived key, and the size threshold decides inline vs
 *    S3-location — i.e. decides whether a session policy is attached at all.
 *  - the per-invocation output key construction (`writeSyncOutput`,
 *    `resolveOutputTarget`, `headOutput`), including invocationId sanitization,
 *    since a raw invocationId carries `:` characters.
 *
 * DSQL is replaced through the exported seam; SSM/STS/S3 are aws-sdk-client-mock.
 * `STARKEEP_CAPABILITY_INLINE_MAX_BYTES` is pinned small so both delivery modes
 * are reachable with tiny fixtures.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { signRequest } from "@starkeep/app-client";
import type {
  AuroraDsqlDatabaseAdapterOptions,
  DatabaseClient,
  DatabaseClientFactory,
} from "@starkeep/storage-aurora-dsql";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import {
  __setBedrockInvokerForTests,
  __setBedrockImageInvokerForTests,
  __setBedrockAsyncInvokerForTests,
  type BedrockInvokeRequest,
  type BedrockAsyncStartRequest,
  type BedrockAsyncStatusResult,
  type BedrockImageGenRequest,
} from "../src/bedrock-client.js";
import { InMemoryCapabilityDb, type GateSeed } from "./in-memory-capability-db.js";
import { recordRow } from "./fake-dsql.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);
const s3Mock = mockClient(S3Client);

const ACCOUNT_ID = "123456789012";
const APP = "photos";
const MODEL = "anthropic.claude-haiku-4-5";
const IMAGE_MODEL = "amazon.nova-canvas-v1:0";
const VIDEO_MODEL = "amazon.nova-reel-v1:1";
const INLINE_MAX = 1024;

const context: LambdaContext = {
  invokedFunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:teststack-cds`,
};

type HandlerModule = typeof import("../src/api-handler.js");
let handler: HandlerModule["handler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];
let resetCapCredsCache: HandlerModule["__resetCapabilityCredsCacheForTests"];

/** Records what the last invoke received, so route wiring is observable. */
let lastConverse: BedrockInvokeRequest | undefined;
let lastImageGen: BedrockImageGenRequest | undefined;
let lastAsyncStart: BedrockAsyncStartRequest | undefined;
let asyncStatusToReturn: BedrockAsyncStatusResult = { status: "InProgress" };

/**
 * DSQL for a capability request: the data-plane grants + clock queries, an
 * optional `shared.records` row, and a real in-memory capability ledger.
 */
class CapabilityDsqlFactory implements DatabaseClientFactory {
  constructor(
    readonly cap: InMemoryCapabilityDb,
    private readonly opts: {
      grantRows?: Array<{ type_id: string; access: string }>;
      records?: Record<string, unknown>[];
    } = {},
  ) {}
  async createClient(_o: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient> {
    const { cap, opts } = this;
    return {
      async query(text: string, values: unknown[] = []) {
        if (text.includes('"access_grants"')) {
          return { rows: opts.grantRows ?? [{ type_id: "image/jpeg", access: "readwrite" }] };
        }
        if (text.includes('"records"')) return { rows: opts.records ?? [] };
        return cap.query(text, values);
      },
      async end() {},
    };
  }
}

function capDb(over: { models?: string[]; reports?: string[]; gates?: GateSeed[] } = {}) {
  return new InMemoryCapabilityDb({
    grant: { models: over.models ?? [MODEL, IMAGE_MODEL, VIDEO_MODEL], reports: over.reports ?? [] },
    gates: over.gates ?? [],
  });
}

function signedEvent(args: {
  method: string;
  subPath: string;
  body?: unknown;
  rawBody?: string;
  appId?: string;
}): APIGatewayEvent {
  const appId = args.appId ?? APP;
  const isBodyless = args.method === "GET" || args.method === "HEAD";
  const bodyStr = args.rawBody ?? (args.body === undefined ? undefined : JSON.stringify(args.body));
  const headers = signRequest({
    appId,
    hmacSecret: `secret-${appId}`,
    method: args.method,
    path: args.subPath,
    ...(isBodyless ? {} : { body: bodyStr }),
  });
  return {
    rawPath: `/apps/${appId}${args.subPath}`,
    requestContext: { http: { method: args.method } },
    headers,
    ...(bodyStr !== undefined ? { body: bodyStr } : {}),
  };
}

function bodyOf(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

/** The session policy on the capability-broker assume, if one was attached. */
function capabilityAssumePolicy(): unknown | undefined {
  const call = stsMock
    .commandCalls(AssumeRoleCommand)
    .find((c) => String(c.args[0].input.RoleArn).includes("capability-broker"));
  const raw = call?.args[0].input.Policy;
  return raw ? JSON.parse(raw) : undefined;
}

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "invalid.test.localdomain";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.AWS_REGION = "us-east-1";
  // Read at module load: pinned small so a 2 KB fixture is a "large" object.
  process.env.STARKEEP_CAPABILITY_INLINE_MAX_BYTES = String(INLINE_MAX);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const mod = await import("../src/api-handler.js");
  handler = mod.handler;
  setDbFactory = mod.__setDatabaseClientFactoryForTests;
  resetCapCredsCache = mod.__resetCapabilityCredsCacheForTests;
});

beforeEach(() => {
  ssmMock.reset();
  stsMock.reset();
  s3Mock.reset();
  resetCapCredsCache();
  lastConverse = undefined;
  lastImageGen = undefined;
  lastAsyncStart = undefined;
  asyncStatusToReturn = { status: "InProgress" };

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

  __setBedrockInvokerForTests({
    async converse(req) {
      lastConverse = req;
      return { text: "a cat on a mat", inputTokens: 100, outputTokens: 8 };
    },
    // eslint-disable-next-line require-yield
    async *converseStream() {
      throw new Error("not used on the buffered route");
    },
  });
  __setBedrockImageInvokerForTests({
    async generateImage(req) {
      lastImageGen = req;
      return { images: [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], format: "png" };
    },
  });
  __setBedrockAsyncInvokerForTests({
    async startAsync(req) {
      lastAsyncStart = req;
      return { invocationArn: `arn:aws:bedrock:us-east-1:${ACCOUNT_ID}:async-invoke/job-1` };
    },
    async getAsyncStatus() {
      return asyncStatusToReturn;
    },
  });
});

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

describe("capability route matching", () => {
  it("GET /capabilities lists the app's grants (runtime config for degraded mode)", async () => {
    setDbFactory(new CapabilityDsqlFactory(capDb({ models: [MODEL], reports: ["input:megapixels"] })));
    const res = await handler(signedEvent({ method: "GET", subPath: "/capabilities" }), context);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({
      capabilities: [
        { name: "bedrock.invoke", models: [MODEL], reports: ["input:megapixels"] },
      ],
    });
  });

  it("GET /capabilities returns an empty list for an app with no grants", async () => {
    setDbFactory(new CapabilityDsqlFactory(new InMemoryCapabilityDb({ grant: null })));
    const res = await handler(signedEvent({ method: "GET", subPath: "/capabilities" }), context);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ capabilities: [] });
  });

  it("does not match a capability route on the wrong HTTP method", async () => {
    setDbFactory(new CapabilityDsqlFactory(capDb()));
    for (const [method, subPath] of [
      ["GET", "/capabilities/bedrock.invoke/invoke"],
      ["GET", "/capabilities/bedrock.invoke/invoke-async"],
      ["GET", "/capabilities/bedrock.invoke/report"],
      ["POST", "/capabilities"],
      ["POST", "/capabilities/bedrock.invoke/async/inv-1"],
    ] as const) {
      const res = await handler(
        signedEvent({ method, subPath, ...(method === "POST" ? { body: {} } : {}) }),
        context,
      );
      expect([404, 405]).toContain(res.statusCode);
    }
  });

  it("404s an unrecognized capability sub-path", async () => {
    setDbFactory(new CapabilityDsqlFactory(capDb()));
    const res = await handler(
      signedEvent({ method: "POST", subPath: "/capabilities/bedrock.invoke/nope", body: {} }),
      context,
    );
    expect(res.statusCode).toBe(404);
  });

  it("URL-decodes the capability name from the path", async () => {
    setDbFactory(new CapabilityDsqlFactory(capDb()));
    const res = await handler(
      signedEvent({
        method: "POST",
        // "bedrock%2Einvoke" decodes to the real name; an undecoded segment
        // would 404 at the broker instead of running.
        subPath: "/capabilities/bedrock%2Einvoke/invoke",
        body: { model: MODEL, prompt: "hi" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
  });

  it("404s an unknown capability name at the broker (not the router)", async () => {
    setDbFactory(new CapabilityDsqlFactory(capDb()));
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: "/capabilities/bedrock.knowledgeBase/invoke",
        body: { model: MODEL, prompt: "hi" },
      }),
      context,
    );
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error).toMatch(/Unknown capability/);
  });

  it("requires a signature like every other /apps route", async () => {
    setDbFactory(new CapabilityDsqlFactory(capDb()));
    const res = await handler(
      {
        rawPath: `/apps/${APP}/capabilities/bedrock.invoke/invoke`,
        requestContext: { http: { method: "POST" } },
        headers: {},
        body: JSON.stringify({ model: MODEL, prompt: "hi" }),
      },
      context,
    );
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

describe("capability route body handling", () => {
  beforeEach(() => setDbFactory(new CapabilityDsqlFactory(capDb())));

  it("400s malformed JSON on every body-taking capability route", async () => {
    for (const subPath of [
      "/capabilities/bedrock.invoke/invoke",
      "/capabilities/bedrock.invoke/invoke-async",
      "/capabilities/bedrock.invoke/report",
    ]) {
      const res = await handler(
        signedEvent({ method: "POST", subPath, rawBody: "{not json" }),
        context,
      );
      expect(res.statusCode).toBe(400);
      expect(bodyOf(res).error).toBe("Invalid JSON body");
    }
  });

  it("treats an absent body as {} and reports the missing model", async () => {
    const res = await handler(
      signedEvent({ method: "POST", subPath: "/capabilities/bedrock.invoke/invoke" }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error).toBe("model is required");
  });

  it("decodes a base64-encoded body before parsing", async () => {
    const payload = JSON.stringify({ model: MODEL, prompt: "wörld" });
    const headers = signRequest({
      appId: APP,
      hmacSecret: `secret-${APP}`,
      method: "POST",
      path: "/capabilities/bedrock.invoke/invoke",
      body: Buffer.from(payload, "utf8"),
    });
    const res = await handler(
      {
        rawPath: `/apps/${APP}/capabilities/bedrock.invoke/invoke`,
        requestContext: { http: { method: "POST" } },
        headers,
        body: Buffer.from(payload, "utf8").toString("base64"),
        isBase64Encoded: true,
      },
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(lastConverse?.prompt).toBe("wörld");
  });
});

// ---------------------------------------------------------------------------
// POST /capabilities/:name/report
// ---------------------------------------------------------------------------

describe("POST /capabilities/:name/report", () => {
  const reportPath = "/capabilities/bedrock.invoke/report";

  async function seededDb() {
    const cap = capDb({ reports: ["output:megapixels", "output:frames"] });
    // A prior invocation to report against.
    cap.seedLedger({ dimension: "requests", unit: "all", quantity: 1, invocation_id: "inv-1" });
    return cap;
  }

  it("400s a body with no invocationId", async () => {
    setDbFactory(new CapabilityDsqlFactory(await seededDb()));
    const res = await handler(
      signedEvent({ method: "POST", subPath: reportPath, body: { reports: { "output:megapixels": 4 } } }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error).toBe("invocationId is required");
  });

  it("404s an invocation that is not this app's", async () => {
    const cap = await seededDb();
    setDbFactory(new CapabilityDsqlFactory(cap));
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: reportPath,
        body: { invocationId: "someone-elses", reports: { "output:megapixels": 4 } },
      }),
      context,
    );
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error).toBe("unknown_invocation");
  });

  it("403s an app with no capability grant", async () => {
    setDbFactory(new CapabilityDsqlFactory(new InMemoryCapabilityDb({ grant: null })));
    const res = await handler(
      signedEvent({ method: "POST", subPath: reportPath, body: { invocationId: "inv-1" } }),
      context,
    );
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res).error).toBe("not_granted");
  });

  it("404s an unknown capability name", async () => {
    setDbFactory(new CapabilityDsqlFactory(await seededDb()));
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: "/capabilities/bedrock.knowledgeBase/report",
        body: { invocationId: "inv-1" },
      }),
      context,
    );
    expect(res.statusCode).toBe(404);
  });

  it("records declared output dimensions and appends committed ledger rows", async () => {
    const cap = await seededDb();
    setDbFactory(new CapabilityDsqlFactory(cap));
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: reportPath,
        body: { invocationId: "inv-1", reports: { "output:megapixels": 4, "output:frames": 30 } },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ ok: true, recorded: 2 });
    const appended = cap.ledger.filter((r) => r.dimension === "output");
    expect(appended.map((r) => [r.unit, r.quantity, r.status])).toEqual([
      ["megapixels", 4, "committed"],
      ["frames", 30, "committed"],
    ]);
    // The provider/model are recovered from the original invocation, not the body.
    expect(appended.every((r) => r.provider === "anthropic")).toBe(true);
  });

  it("records nothing when the body carries no reports at all", async () => {
    const cap = await seededDb();
    setDbFactory(new CapabilityDsqlFactory(cap));
    const res = await handler(
      signedEvent({ method: "POST", subPath: reportPath, body: { invocationId: "inv-1" } }),
      context,
    );
    expect(bodyOf(res)).toEqual({ ok: true, recorded: 0 });
    expect(cap.ledger.filter((r) => r.dimension === "output")).toHaveLength(0);
  });

  it("ignores INPUT dimensions on the output-report route", async () => {
    const cap = capDb({ reports: ["input:megapixels", "output:megapixels"] });
    cap.seedLedger({ dimension: "requests", unit: "all", quantity: 1, invocation_id: "inv-1" });
    setDbFactory(new CapabilityDsqlFactory(cap));
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: reportPath,
        body: { invocationId: "inv-1", reports: { "input:megapixels": 9, "output:megapixels": 4 } },
      }),
      context,
    );
    expect(bodyOf(res)).toEqual({ ok: true, recorded: 1 });
    expect(cap.ledger.some((r) => r.dimension === "input")).toBe(false);
  });

  it("ignores undeclared, generic, and non-finite report values", async () => {
    const cap = capDb({ reports: ["output:megapixels"] });
    cap.seedLedger({ dimension: "requests", unit: "all", quantity: 1, invocation_id: "inv-1" });
    setDbFactory(new CapabilityDsqlFactory(cap));
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: reportPath,
        body: {
          invocationId: "inv-1",
          reports: {
            "output:frames": 30, // not declared
            "output:bytes": 100, // generic — CDS-measured, never app-reported
            "output:megapixels": "4", // not a number
            nonsense: 1, // no dimension:unit split
          },
        },
      }),
      context,
    );
    expect(bodyOf(res)).toEqual({ ok: true, recorded: 0 });
    expect(cap.ledger.filter((r) => r.dimension === "output")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// makeCapabilityContentReader (by-reference authorization)
// ---------------------------------------------------------------------------

describe("by-reference content read (plan §3.4 step 4)", () => {
  const JPEG_KEY = "shared/image/ab/cdefabcdef";

  function invokeWith(args: {
    records?: Record<string, unknown>[];
    grantRows?: Array<{ type_id: string; access: string }>;
    contentRef: { recordId?: string; objectKey?: string };
    cap?: InMemoryCapabilityDb;
  }) {
    setDbFactory(
      new CapabilityDsqlFactory(args.cap ?? capDb(), {
        records: args.records,
        ...(args.grantRows ? { grantRows: args.grantRows } : {}),
      }),
    );
    return handler(
      signedEvent({
        method: "POST",
        subPath: "/capabilities/bedrock.invoke/invoke",
        body: { model: MODEL, prompt: "Describe this.", contentRef: args.contentRef, maxTokens: 100 },
      }),
      context,
    );
  }

  /** A `shared.records` row for a readable JPEG of the given size. */
  function jpegRecord(over: Record<string, unknown> = {}) {
    return recordRow({
      id: "rec-1",
      type: "image/jpeg",
      mime_type: "image/jpeg",
      object_storage_key: JPEG_KEY,
      size_bytes: 512,
      ...over,
    });
  }

  function scriptS3(opts: { size?: number; contentType?: string; bytes?: Uint8Array; head?: boolean } = {}) {
    if (opts.head === false) {
      s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error("NotFound"), { name: "NotFound" }));
    } else {
      s3Mock.on(HeadObjectCommand).resolves({
        ContentLength: opts.size ?? 512,
        ContentType: opts.contentType ?? "image/jpeg",
      });
    }
    const bytes = opts.bytes ?? new Uint8Array([1, 2, 3]);
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => bytes } as never,
      ContentType: opts.contentType ?? "image/jpeg",
      ContentLength: bytes.byteLength,
    });
  }

  it("404s a missing record", async () => {
    scriptS3();
    const res = await invokeWith({ records: [], contentRef: { recordId: "rec-1" } });
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error).toBe("content_not_found");
  });

  it("404s a deleted (tombstoned) record", async () => {
    scriptS3();
    const res = await invokeWith({
      records: [jpegRecord({ deleted_at: "2026-07-01T00:00:00Z" })],
      contentRef: { recordId: "rec-1" },
    });
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error).toBe("content_not_found");
  });

  it("403s a record whose TYPE the app cannot read", async () => {
    scriptS3();
    const res = await invokeWith({
      records: [jpegRecord({ type: "audio/mp3", mime_type: "audio/mp3" })],
      grantRows: [{ type_id: "image/jpeg", access: "readwrite" }],
      contentRef: { recordId: "rec-1" },
    });
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res).error).toBe("content_forbidden");
    // Denied before any S3 access at all.
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it("404s a record that carries no bytes", async () => {
    scriptS3();
    const res = await invokeWith({
      records: [jpegRecord({ object_storage_key: null })],
      contentRef: { recordId: "rec-1" },
    });
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error).toBe("content_has_no_bytes");
  });

  it("re-authorizes a RECORD-DERIVED key against the caller's grants (the belt)", async () => {
    scriptS3();
    // A record row pointing at another app's syncable area — the record's own
    // type check passed, so only the key re-check stops this.
    const res = await invokeWith({
      records: [jpegRecord({ object_storage_key: "apps/notes/syncable/secret.jpg" })],
      contentRef: { recordId: "rec-1" },
    });
    expect(res.statusCode).toBe(403);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  it("rejects a traversal key on a record-derived key", async () => {
    scriptS3();
    const res = await invokeWith({
      records: [jpegRecord({ object_storage_key: "shared/image/../audio/aaa" })],
      contentRef: { recordId: "rec-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  it("400s a contentRef with neither recordId nor objectKey", async () => {
    scriptS3();
    const res = await invokeWith({ contentRef: {} });
    expect(res.statusCode).toBe(400);
  });

  it("authorizes a direct objectKey against the caller's grants", async () => {
    scriptS3();
    const denied = await invokeWith({
      grantRows: [{ type_id: "audio/mp3", access: "read" }], // no image read
      contentRef: { objectKey: JPEG_KEY },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await invokeWith({ contentRef: { objectKey: JPEG_KEY } });
    expect(allowed.statusCode).toBe(200);
  });

  it("404s when the app-role HEAD cannot confirm readability", async () => {
    // S3 collapses missing and forbidden to the same signal, so a null HEAD is
    // the failure of the load-bearing readability proof.
    scriptS3({ head: false });
    const res = await invokeWith({
      records: [jpegRecord()],
      contentRef: { recordId: "rec-1" },
    });
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error).toBe("content_not_resident");
    // No download was attempted.
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it("runs TEXT-ONLY (no bytes, no download) for a mime Bedrock can't take as an image", async () => {
    scriptS3({ contentType: "application/pdf" });
    const res = await invokeWith({
      records: [
        jpegRecord({
          type: "document/pdf",
          mime_type: "application/pdf",
          object_storage_key: "shared/document/ab/cdefabcdef",
        }),
      ],
      grantRows: [{ type_id: "document/pdf", access: "read" }],
      contentRef: { recordId: "rec-1" },
    });
    expect(res.statusCode).toBe(200);
    // The request ran, but with NO image content — and the object was never
    // downloaded to discover that.
    expect(lastConverse?.images).toBeUndefined();
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(1);
  });

  it("INLINES a small image (downloaded under the app role, no session policy)", async () => {
    scriptS3({ size: 512, bytes: new Uint8Array([9, 9, 9]) });
    const res = await invokeWith({
      records: [jpegRecord({ size_bytes: 512 })],
      contentRef: { recordId: "rec-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    expect(lastConverse?.images).toEqual([{ format: "jpeg", bytes: new Uint8Array([9, 9, 9]) }]);
    // Inline delivery means the capability role needs no S3 reach at all.
    expect(capabilityAssumePolicy()).toBeUndefined();
  });

  it("delivers a LARGE image by S3 location under a single-key session policy", async () => {
    const big = INLINE_MAX + 1;
    scriptS3({ size: big });
    const res = await invokeWith({
      records: [jpegRecord({ size_bytes: big })],
      contentRef: { recordId: "rec-1" },
    });
    expect(res.statusCode).toBe(200);
    // NOT downloaded — Bedrock reads it directly.
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(lastConverse?.images).toEqual([
      {
        format: "jpeg",
        s3Uri: `s3://fake-bucket/${JPEG_KEY}`,
        // Pins the read to this account (confused-deputy guard).
        bucketOwner: ACCOUNT_ID,
      },
    ]);
    const policy = capabilityAssumePolicy() as { Statement: Array<{ Sid: string; Resource: string[] }> };
    expect(policy).toBeDefined();
    const s3Stmt = policy.Statement.find((s) => s.Sid === "SessionS3OneKey")!;
    expect(s3Stmt.Resource).toEqual([`arn:aws:s3:::fake-bucket/${JPEG_KEY}`]);
  });

  it("picks the delivery mode from the RECORD's size, not S3's reported size", async () => {
    // The record row is authoritative for size when present (`recordSize ?? head.size`).
    scriptS3({ size: 10 });
    await invokeWith({
      records: [jpegRecord({ size_bytes: INLINE_MAX + 1 })],
      contentRef: { recordId: "rec-1" },
    });
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it("falls back to the HEAD size for a key with no record row", async () => {
    scriptS3({ size: INLINE_MAX + 1 });
    const res = await invokeWith({ contentRef: { objectKey: JPEG_KEY } });
    expect(res.statusCode).toBe(200);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(lastConverse?.images?.[0]).toMatchObject({ s3Uri: `s3://fake-bucket/${JPEG_KEY}` });
  });

  it("maps each accepted mime to its Bedrock image format", async () => {
    for (const [mime, format] of [
      ["image/png", "png"],
      ["image/jpeg", "jpeg"],
      ["image/jpg", "jpeg"],
      ["image/gif", "gif"],
      ["image/webp", "webp"],
    ] as const) {
      scriptS3({ contentType: mime, size: 10 });
      await invokeWith({
        records: [jpegRecord({ mime_type: mime, size_bytes: 10 })],
        contentRef: { recordId: "rec-1" },
      });
      expect(lastConverse?.images?.[0]).toMatchObject({ format });
      s3Mock.reset();
    }
  });

  it("counts the CDS-measured input bytes into the ledger", async () => {
    const cap = capDb();
    scriptS3({ size: 512 });
    await invokeWith({
      cap,
      records: [jpegRecord({ size_bytes: 512 })],
      contentRef: { recordId: "rec-1" },
    });
    expect(
      cap.ledger.find((r) => r.dimension === "input" && r.unit === "bytes")?.quantity,
    ).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// Sync image output — writeSyncOutput key construction
// ---------------------------------------------------------------------------

describe("POST /capabilities/:name/invoke — sync image output keys", () => {
  it("writes each image under a sanitized per-invocation folder in the app's syncable area", async () => {
    const cap = capDb();
    setDbFactory(new CapabilityDsqlFactory(cap));
    s3Mock.on(PutObjectCommand).resolves({});
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: "/capabilities/bedrock.invoke/invoke",
        body: { model: IMAGE_MODEL, prompt: "a watercolor cat" },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res) as {
      invocationId: string;
      output: { bucket: string; keyPrefix: string; keys: string[]; totalBytes: number };
    };

    // The raw invocationId carries ':' separators, which must never reach an S3
    // key — the folder name is the sanitized form.
    expect(body.invocationId).toContain(":");
    const safe = body.invocationId.replace(/[^a-zA-Z0-9_-]/g, "-");
    expect(body.output.keyPrefix).toBe(`apps/${APP}/syncable/capability-image/${safe}`);
    expect(body.output.keyPrefix).not.toContain(":");
    expect(body.output.keys).toEqual([`${body.output.keyPrefix}/image-0.png`]);
    expect(body.output.bucket).toBe("fake-bucket");
    expect(body.output.totalBytes).toBe(8);

    // The bytes were written under the APP role to exactly that key.
    const put = s3Mock.commandCalls(PutObjectCommand);
    expect(put).toHaveLength(1);
    expect(put[0]!.args[0].input.Key).toBe(`${body.output.keyPrefix}/image-0.png`);
    expect(put[0]!.args[0].input.ContentType).toBe("image/png");

    // The capability role never writes on this path — no PutObject in any
    // session policy.
    expect(JSON.stringify(capabilityAssumePolicy() ?? {})).not.toContain("PutObject");
    // Ledger records the CDS-measured output bytes.
    expect(
      cap.ledger.find((r) => r.dimension === "output" && r.unit === "bytes")?.quantity,
    ).toBe(8);
  });

  it("derives the file extension from the generated content type", async () => {
    setDbFactory(new CapabilityDsqlFactory(capDb()));
    s3Mock.on(PutObjectCommand).resolves({});
    __setBedrockImageInvokerForTests({
      async generateImage(req) {
        lastImageGen = req;
        return { images: [new Uint8Array([1])], format: "jpeg" };
      },
    });
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: "/capabilities/bedrock.invoke/invoke",
        body: { model: IMAGE_MODEL, prompt: "a cat" },
      }),
      context,
    );
    const body = bodyOf(res) as { output: { keys: string[] } };
    expect(body.output.keys[0]).toMatch(/\/image-0\.jpeg$/);
  });

  it("numbers multiple generated images within the one invocation folder", async () => {
    setDbFactory(new CapabilityDsqlFactory(capDb()));
    s3Mock.on(PutObjectCommand).resolves({});
    __setBedrockImageInvokerForTests({
      async generateImage() {
        return { images: [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])], format: "png" };
      },
    });
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: "/capabilities/bedrock.invoke/invoke",
        body: { model: IMAGE_MODEL, prompt: "cats" },
      }),
      context,
    );
    const body = bodyOf(res) as { output: { keyPrefix: string; keys: string[]; totalBytes: number } };
    expect(body.output.keys).toEqual([
      `${body.output.keyPrefix}/image-0.png`,
      `${body.output.keyPrefix}/image-1.png`,
    ]);
    expect(body.output.totalBytes).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Async start / status routes
// ---------------------------------------------------------------------------

describe("POST /capabilities/:name/invoke-async", () => {
  it("202s with the per-invocation output target and scopes the assume to it", async () => {
    const cap = capDb();
    setDbFactory(new CapabilityDsqlFactory(cap));
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: "/capabilities/bedrock.invoke/invoke-async",
        body: { model: VIDEO_MODEL, prompt: "a cat surfing" },
      }),
      context,
    );
    expect(res.statusCode).toBe(202);
    const body = bodyOf(res) as {
      invocationId: string;
      status: string;
      output: { bucket: string; keyPrefix: string };
    };
    const safe = body.invocationId.replace(/[^a-zA-Z0-9_-]/g, "-");
    expect(body.status).toBe("running");
    expect(body.output.keyPrefix).toBe(`apps/${APP}/syncable/capability-async/${safe}`);
    expect(body.output.keyPrefix).not.toContain(":");

    // Bedrock writes the output itself, so it is handed the folder URI…
    expect(lastAsyncStart?.outputS3Uri).toBe(`s3://fake-bucket/${body.output.keyPrefix}/`);
    expect(lastAsyncStart?.outputBucketOwner).toBe(ACCOUNT_ID);
    // …and the assume is narrowed to exactly that folder, plus the async verbs.
    const policy = capabilityAssumePolicy() as {
      Statement: Array<{ Sid: string; Action: string | string[]; Resource: string | string[] }>;
    };
    const put = policy.Statement.find((s) => s.Sid === "SessionS3OutputPrefix")!;
    expect(put.Resource).toEqual([`arn:aws:s3:::fake-bucket/${body.output.keyPrefix}/*`]);
    expect(policy.Statement[0]!.Action).toContain("bedrock:StartAsyncInvoke");

    // The job row is persisted so a later poll can find it.
    expect(cap.asyncJobs).toHaveLength(1);
    expect(cap.asyncJobs[0]).toMatchObject({
      app_id: APP,
      status: "running",
      output_key_prefix: body.output.keyPrefix,
    });
  });

  it("400s a text model on the async route", async () => {
    setDbFactory(new CapabilityDsqlFactory(capDb()));
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: "/capabilities/bedrock.invoke/invoke-async",
        body: { model: MODEL, prompt: "hi" },
      }),
      context,
    );
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error).toBe("output_not_async");
  });
});

describe("GET /capabilities/:name/async/:invocationId", () => {
  /** Start a job and return its id plus the shared ledger. */
  async function startJob() {
    const cap = capDb();
    setDbFactory(new CapabilityDsqlFactory(cap));
    const res = await handler(
      signedEvent({
        method: "POST",
        subPath: "/capabilities/bedrock.invoke/invoke-async",
        body: { model: VIDEO_MODEL, prompt: "a cat surfing" },
      }),
      context,
    );
    const body = bodyOf(res) as { invocationId: string; output: { keyPrefix: string } };
    return { cap, invocationId: body.invocationId, keyPrefix: body.output.keyPrefix };
  }

  function poll(invocationId: string) {
    // The invocationId contains ':' and must survive the path round-trip.
    const subPath = `/capabilities/bedrock.invoke/async/${encodeURIComponent(invocationId)}`;
    return handler(signedEvent({ method: "GET", subPath }), context);
  }

  it("reports a running job without touching the ledger", async () => {
    const { cap, invocationId } = await startJob();
    const reservedBefore = cap.ledger.filter((r) => r.status === "reserved").length;
    asyncStatusToReturn = { status: "InProgress" };
    const res = await poll(invocationId);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ status: "running" });
    expect(cap.ledger.filter((r) => r.status === "reserved")).toHaveLength(reservedBefore);
  });

  it("404s an invocation id that is not this app's", async () => {
    await startJob();
    const res = await poll("photos:bedrock.invoke:async:1:nope");
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res).error).toBe("unknown_invocation");
  });

  it("commits the reservation and lists + totals the output on the completing poll", async () => {
    const { cap, invocationId, keyPrefix } = await startJob();
    asyncStatusToReturn = { status: "Completed" };
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: `${keyPrefix}/output.mp4` }, { Key: `${keyPrefix}/manifest.json` }],
    });
    s3Mock.on(HeadObjectCommand).callsFake(async (input: { Key?: string }) => ({
      ContentLength: input.Key!.endsWith(".mp4") ? 5_000_000 : 120,
    }));

    const res = await poll(invocationId);
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res) as {
      status: string;
      output: { keys: string[]; totalBytes: number; keyPrefix: string };
    };
    expect(body.status).toBe("completed");
    expect(body.output.keys).toEqual([`${keyPrefix}/output.mp4`, `${keyPrefix}/manifest.json`]);
    expect(body.output.totalBytes).toBe(5_000_120);
    // The listing is prefix-scoped to the invocation's own folder.
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0]!.args[0].input.Prefix).toBe(`${keyPrefix}/`);

    // Reservation committed; the CDS-measured output bytes appended.
    expect(cap.ledger.some((r) => r.status === "reserved")).toBe(false);
    expect(
      cap.ledger.find((r) => r.dimension === "output" && r.unit === "bytes")?.quantity,
    ).toBe(5_000_120);
    expect(cap.asyncJobs[0]!.status).toBe("completed");
  });

  it("skips objects the HEAD cannot confirm when totalling", async () => {
    const { invocationId, keyPrefix } = await startJob();
    asyncStatusToReturn = { status: "Completed" };
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: `${keyPrefix}/output.mp4` }, { Key: `${keyPrefix}/gone.json` }],
    });
    s3Mock.on(HeadObjectCommand).callsFake(async (input: { Key?: string }) => {
      if (input.Key!.endsWith("gone.json")) {
        throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      }
      return { ContentLength: 42 };
    });
    const res = await poll(invocationId);
    const body = bodyOf(res) as { output: { keys: string[]; totalBytes: number } };
    expect(body.output.keys).toEqual([`${keyPrefix}/output.mp4`]);
    expect(body.output.totalBytes).toBe(42);
  });

  it("releases the reservation when the job failed", async () => {
    const { cap, invocationId } = await startJob();
    asyncStatusToReturn = { status: "Failed", failureMessage: "content filtered" };
    const res = await poll(invocationId);
    expect(bodyOf(res)).toEqual({ status: "failed", error: "content filtered" });
    expect(cap.ledger.every((r) => r.status === "released")).toBe(true);
    expect(cap.asyncJobs[0]!.status).toBe("failed");
  });

  it("replays a terminal job idempotently without re-reconciling", async () => {
    const { cap, invocationId, keyPrefix } = await startJob();
    asyncStatusToReturn = { status: "Completed" };
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [{ Key: `${keyPrefix}/output.mp4` }] });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
    await poll(invocationId);
    const outputRowsAfterFirst = cap.ledger.filter(
      (r) => r.dimension === "output" && r.unit === "bytes",
    ).length;

    const again = await poll(invocationId);
    expect(again.statusCode).toBe(200);
    expect((bodyOf(again) as { status: string }).status).toBe("completed");
    expect(
      cap.ledger.filter((r) => r.dimension === "output" && r.unit === "bytes"),
    ).toHaveLength(outputRowsAfterFirst);
  });
});
