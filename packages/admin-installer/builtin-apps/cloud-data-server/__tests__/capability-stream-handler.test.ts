/**
 * `streamHandler` — the streaming capability plane (direct Lambda
 * InvokeWithResponseStream, no API Gateway, no Function URL).
 *
 * Two things make this worth its own suite:
 *
 *  - IAM only authorizes *reaching* this function. App identity is established
 *    by the in-handler HMAC verifier, exactly as on the gateway data plane — so
 *    an IAM-authorized caller must still be unable to act as another app.
 *  - The invoke returns a RAW byte stream with no HTTP status prelude, so EVERY
 *    outcome — 404, 401, 403, 429, 500 — is encoded in-band as a single `error`
 *    SSE frame. If that mapping regresses, a rejection becomes an empty stream
 *    and the client can't tell "denied" from "produced nothing".
 *
 * SSM/STS are mocked and DSQL is replaced through the exported test seam; the
 * Bedrock invoker is never reached except where a test drives a full stream.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand, ParameterNotFound } from "@aws-sdk/client-ssm";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { signRequest } from "@starkeep/app-client";
import type {
  AuroraDsqlDatabaseAdapterOptions,
  DatabaseClient,
  DatabaseClientFactory,
} from "@starkeep/storage-aurora-dsql";
import type { APIGatewayEvent, LambdaContext } from "../src/handler-utils.js";
import type { CapabilityStreamEvent } from "../src/capability-handler.js";
import { __setBedrockInvokerForTests, type BedrockInvoker } from "../src/bedrock-client.js";
import { InMemoryCapabilityDb, type GateSeed } from "./in-memory-capability-db.js";

const ssmMock = mockClient(SSMClient);
const stsMock = mockClient(STSClient);

const ACCOUNT_ID = "123456789012";
const context: LambdaContext = {
  invokedFunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:teststack-cds-stream`,
};

type HandlerModule = typeof import("../src/api-handler.js");
let streamHandler: HandlerModule["streamHandler"];
let setDbFactory: HandlerModule["__setDatabaseClientFactoryForTests"];

/** Collects everything the handler writes, and records whether it ended. */
class CapturingStream {
  chunks: string[] = [];
  ended = false;
  write(chunk: string): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  end(): void {
    this.ended = true;
  }
  get raw(): string {
    return this.chunks.join("");
  }
  /** Parse the SSE frames back into the shared event union. */
  events(): CapabilityStreamEvent[] {
    return this.raw
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice("data: ".length)) as CapabilityStreamEvent);
  }
  asWritable(): NodeJS.WritableStream & LambdaContext {
    return this as unknown as NodeJS.WritableStream & LambdaContext;
  }
}

/**
 * A DSQL factory serving the data-plane grants query and delegating everything
 * capability-shaped to a real in-memory ledger. Tracks how many clients were
 * opened vs closed so the handler's `finally` cleanup is observable.
 */
class StreamDsqlFactory implements DatabaseClientFactory {
  opened = 0;
  closed = 0;
  constructor(
    readonly cap: InMemoryCapabilityDb,
    private readonly grantRows: Array<{ type_id: string; access: string }> = [
      { type_id: "image/jpeg", access: "readwrite" },
    ],
  ) {}
  async createClient(_o: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient> {
    this.opened++;
    const cap = this.cap;
    const self = this;
    return {
      async query(text: string, values: unknown[] = []) {
        if (text.includes('"access_grants"')) return { rows: self.grantRows };
        return cap.query(text, values);
      },
      async end() {
        self.closed++;
      },
    };
  }
}

const MODEL = "anthropic.claude-haiku-4-5";

/** Yields two text chunks then usage — no AWS. */
const fakeStreamInvoker: BedrockInvoker = {
  async converse() {
    throw new Error("not used on the streaming route");
  },
  async *converseStream() {
    yield { type: "text" as const, text: "a cat " };
    yield { type: "text" as const, text: "on a mat" };
    yield { type: "done" as const, inputTokens: 1200, outputTokens: 8 };
  },
};

function capDb(gates: GateSeed[] = [], models: string[] = [MODEL]): InMemoryCapabilityDb {
  return new InMemoryCapabilityDb({ grant: { models, reports: [] }, gates });
}

function streamEvent(args: {
  appId: string;
  subPath?: string;
  method?: string;
  body?: unknown;
  /** Sign as this app instead of `appId` (spoof attempt). */
  signAs?: string;
  signWith?: string;
  headers?: Record<string, string>;
  base64?: boolean;
}): APIGatewayEvent {
  const subPath = args.subPath ?? "/capabilities/bedrock.invoke/invoke-stream";
  const method = args.method ?? "POST";
  const bodyStr = args.body === undefined ? undefined : JSON.stringify(args.body);
  const headers =
    args.headers ??
    signRequest({
      appId: args.signAs ?? args.appId,
      hmacSecret: args.signWith ?? `secret-${args.signAs ?? args.appId}`,
      method,
      path: subPath,
      ...(bodyStr === undefined ? {} : { body: bodyStr }),
    });
  return {
    rawPath: `/apps/${args.appId}${subPath}`,
    requestContext: { http: { method } },
    headers,
    ...(bodyStr === undefined
      ? {}
      : args.base64
        ? { body: Buffer.from(bodyStr, "utf8").toString("base64"), isBase64Encoded: true }
        : { body: bodyStr }),
  };
}

async function run(event: APIGatewayEvent): Promise<CapturingStream> {
  const out = new CapturingStream();
  await streamHandler(event, out.asWritable(), context);
  return out;
}

/** The single in-band error frame a rejected request must produce. */
function soleError(out: CapturingStream): Extract<CapabilityStreamEvent, { type: "error" }> {
  const evts = out.events();
  expect(evts).toHaveLength(1);
  const e = evts[0]!;
  if (e.type !== "error") throw new Error(`expected an error frame, got ${e.type}`);
  return e;
}

beforeAll(async () => {
  process.env.STACK_PREFIX = "teststack";
  process.env.AURORA_ENDPOINT = "invalid.test.localdomain";
  process.env.S3_BUCKET = "fake-bucket";
  process.env.AWS_REGION = "us-east-1";
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/api-handler.js");
  streamHandler = mod.streamHandler;
  setDbFactory = mod.__setDatabaseClientFactoryForTests;
});

beforeEach(() => {
  ssmMock.reset();
  stsMock.reset();
  __setBedrockInvokerForTests(fakeStreamInvoker);
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

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("streamHandler routing", () => {
  it("404s a path outside /apps/{appId} without consulting SSM", async () => {
    const out = await run({
      rawPath: "/health",
      requestContext: { http: { method: "POST" } },
      headers: {},
    });
    expect(soleError(out)).toMatchObject({ status: 404, error: "not_found" });
    expect(ssmMock.calls()).toHaveLength(0);
    expect(out.ended).toBe(true);
  });

  it("404s any sub-path that is not /capabilities/:name/invoke-stream", async () => {
    for (const subPath of [
      "/data/records",
      "/capabilities/bedrock.invoke/invoke",
      "/capabilities/bedrock.invoke/invoke-stream/extra",
      "/capabilities//invoke-stream",
    ]) {
      const out = await run(streamEvent({ appId: "sr-route", subPath, body: {} }));
      expect(soleError(out)).toMatchObject({ status: 404, error: "not_found" });
    }
    // Never got as far as the HMAC gate.
    expect(ssmMock.calls()).toHaveLength(0);
  });

  it("404s a non-POST method on the stream route", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const out = await run(streamEvent({ appId: "sr-method", method, body: {} }));
      expect(soleError(out)).toMatchObject({ status: 404, error: "not_found" });
    }
  });

  it("accepts a lowercase HTTP method (normalized before matching)", async () => {
    setDbFactory(new StreamDsqlFactory(capDb()));
    // Signed as POST; the router upper-cases before matching, and the HMAC
    // canonicalization must agree or the request would 401 instead.
    const event = streamEvent({ appId: "photos", body: { model: MODEL, prompt: "hi" } });
    event.requestContext.http.method = "post";
    const out = await run(event);
    expect(out.events().map((e) => e.type)).toEqual(["text", "text", "done"]);
    setDbFactory(null);
  });

  it("URL-decodes the capability name and 404s an unknown one at the broker", async () => {
    setDbFactory(new StreamDsqlFactory(capDb()));
    const out = await run(
      streamEvent({
        appId: "sr-capname",
        subPath: "/capabilities/bedrock.knowledgeBase/invoke-stream",
        body: { model: MODEL, prompt: "hi" },
      }),
    );
    // 404 from the BROKER (unknown capability), having passed routing + auth.
    expect(soleError(out).status).toBe(404);
    expect(ssmMock.calls().length).toBeGreaterThan(0);
    setDbFactory(null);
  });
});

// ---------------------------------------------------------------------------
// HMAC — the streaming plane's only app identity
// ---------------------------------------------------------------------------

describe("streamHandler HMAC gate", () => {
  it("401s an app with no SSM credential parameter", async () => {
    ssmMock.reset();
    ssmMock.on(GetParameterCommand).rejects(new ParameterNotFound({ message: "no", $metadata: {} }));
    const out = await run(streamEvent({ appId: "sh-ghost", body: {} }));
    expect(soleError(out)).toMatchObject({ status: 401, error: "unknown_app" });
    expect(stsMock.calls()).toHaveLength(0);
  });

  it("401s a request with no signature headers", async () => {
    const out = await run(streamEvent({ appId: "sh-nohdr", body: {}, headers: {} }));
    const err = soleError(out);
    expect(err.status).toBe(401);
    expect(err.error).toBe("unauthorized");
    expect(err.message).toMatch(/Missing X-Starkeep-App/);
    expect(stsMock.calls()).toHaveLength(0);
  });

  it("401s a signature made with the wrong secret", async () => {
    const out = await run(
      streamEvent({ appId: "sh-badsig", body: {}, signWith: "not-the-secret" }),
    );
    expect(soleError(out)).toMatchObject({ status: 401, error: "unauthorized" });
  });

  it("401s an IAM-authorized caller signing as a DIFFERENT app (no spoofing)", async () => {
    // Reaching this function is IAM-gated, but the payload signature is what
    // establishes WHICH app is acting.
    const out = await run(streamEvent({ appId: "sh-victim", signAs: "sh-attacker", body: {} }));
    const err = soleError(out);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/does not match path/);
    expect(stsMock.calls()).toHaveLength(0);
  });

  it("401s a signature replayed against a different sub-path", async () => {
    const headers = signRequest({
      appId: "sh-replay",
      hmacSecret: "secret-sh-replay",
      method: "POST",
      path: "/capabilities/bedrock.invoke/invoke", // signed for the buffered route
      body: JSON.stringify({ model: MODEL, prompt: "hi" }),
    });
    const out = await run(
      streamEvent({ appId: "sh-replay", body: { model: MODEL, prompt: "hi" }, headers }),
    );
    expect(soleError(out)).toMatchObject({ status: 401, error: "unauthorized" });
  });

  it("401s a stale signature outside the freshness window", async () => {
    const headers = signRequest({
      appId: "sh-stale",
      hmacSecret: "secret-sh-stale",
      method: "POST",
      path: "/capabilities/bedrock.invoke/invoke-stream",
      body: JSON.stringify({}),
      timestamp: Date.now() - 10 * 60_000,
    });
    const out = await run(streamEvent({ appId: "sh-stale", body: {}, headers }));
    expect(soleError(out).status).toBe(401);
  });

  it("401s a body tampered with after signing", async () => {
    const signedBody = JSON.stringify({ model: MODEL, prompt: "cheap" });
    const headers = signRequest({
      appId: "sh-tamper",
      hmacSecret: "secret-sh-tamper",
      method: "POST",
      path: "/capabilities/bedrock.invoke/invoke-stream",
      body: signedBody,
    });
    const event = streamEvent({ appId: "sh-tamper", body: {}, headers });
    event.body = JSON.stringify({ model: MODEL, prompt: "x".repeat(10_000) });
    const out = await run(event);
    expect(soleError(out)).toMatchObject({ status: 401 });
  });

  it("verifies a base64-encoded body against the DECODED bytes", async () => {
    setDbFactory(new StreamDsqlFactory(capDb()));
    const out = await run(
      streamEvent({
        appId: "photos",
        body: { model: MODEL, prompt: "wörld" }, // multi-byte, so the encoding matters
        base64: true,
      }),
    );
    // Passed the gate on the decoded UTF-8 bytes and streamed normally.
    expect(out.events().map((e) => e.type)).toEqual(["text", "text", "done"]);
    setDbFactory(null);
  });
});

// ---------------------------------------------------------------------------
// Body handling + in-band mapping of pre-flight rejections
// ---------------------------------------------------------------------------

describe("streamHandler body + rejection mapping", () => {
  beforeEach(() => setDbFactory(null));

  it("400s a malformed JSON body as an in-band frame", async () => {
    const raw = "{not json";
    const headers = signRequest({
      appId: "sb-badjson",
      hmacSecret: "secret-sb-badjson",
      method: "POST",
      path: "/capabilities/bedrock.invoke/invoke-stream",
      body: raw,
    });
    const out = await run({
      rawPath: "/apps/sb-badjson/capabilities/bedrock.invoke/invoke-stream",
      requestContext: { http: { method: "POST" } },
      headers,
      body: raw,
    });
    expect(soleError(out)).toMatchObject({ status: 400, error: "invalid_body" });
  });

  it("treats an absent body as {} and lets the broker report the missing model", async () => {
    setDbFactory(new StreamDsqlFactory(capDb()));
    const headers = signRequest({
      appId: "sb-nobody",
      hmacSecret: "secret-sb-nobody",
      method: "POST",
      path: "/capabilities/bedrock.invoke/invoke-stream",
    });
    const out = await run({
      rawPath: "/apps/sb-nobody/capabilities/bedrock.invoke/invoke-stream",
      requestContext: { http: { method: "POST" } },
      headers,
    });
    expect(soleError(out)).toMatchObject({ status: 400 });
    setDbFactory(null);
  });

  it("maps a not_granted pre-flight rejection to a 403 error frame (degraded mode)", async () => {
    setDbFactory(new StreamDsqlFactory(new InMemoryCapabilityDb({ grant: null })));
    const out = await run(
      streamEvent({ appId: "photos", body: { model: MODEL, prompt: "hi" } }),
    );
    // The client keys off this exact code to fall back to degraded mode.
    expect(soleError(out)).toMatchObject({ status: 403, error: "not_granted" });
    expect(out.ended).toBe(true);
    setDbFactory(null);
  });

  it("maps a model_not_granted rejection to a 403 frame", async () => {
    setDbFactory(new StreamDsqlFactory(capDb([], ["anthropic.claude-opus-4-8"])));
    const out = await run(streamEvent({ appId: "photos", body: { model: MODEL, prompt: "hi" } }));
    expect(soleError(out)).toMatchObject({ status: 403, error: "model_not_granted" });
    setDbFactory(null);
  });

  it("maps a gate breach to a 429 frame and opens NO stream", async () => {
    const cap = capDb([{ dimension: "requests", unit: "all", scope_app_id: "photos", limit_value: 0 }]);
    setDbFactory(new StreamDsqlFactory(cap));
    const out = await run(streamEvent({ appId: "photos", body: { model: MODEL, prompt: "hi" } }));
    expect(soleError(out)).toMatchObject({ status: 429, error: "gate_exceeded" });
    // The pre-flight reservation was released, not stranded.
    expect(cap.ledger.every((r) => r.status === "released")).toBe(true);
    setDbFactory(null);
  });

  it("maps a non-streamable (image) model to a 400 frame", async () => {
    setDbFactory(new StreamDsqlFactory(capDb([], ["amazon.nova-canvas-v1:0"])));
    const out = await run(
      streamEvent({ appId: "photos", body: { model: "amazon.nova-canvas-v1:0", prompt: "a cat" } }),
    );
    expect(soleError(out)).toMatchObject({ status: 400, error: "output_not_streamable" });
    setDbFactory(null);
  });

  it("maps an unexpected internal failure to a 500 frame rather than a silent hang", async () => {
    setDbFactory({
      async createClient(): Promise<DatabaseClient> {
        throw new Error("DSQL is on fire");
      },
    });
    const out = await run(streamEvent({ appId: "sb-boom", body: { model: MODEL, prompt: "hi" } }));
    expect(soleError(out)).toMatchObject({ status: 500, error: "internal_error" });
    expect(out.ended).toBe(true);
    setDbFactory(null);
  });
});

// ---------------------------------------------------------------------------
// SSE framing + cleanup
// ---------------------------------------------------------------------------

describe("streamHandler SSE framing and cleanup", () => {
  it("streams text frames then a terminal done frame, one `data: …\\n\\n` per event", async () => {
    const cap = capDb();
    setDbFactory(new StreamDsqlFactory(cap));
    const out = await run(streamEvent({ appId: "photos", body: { model: MODEL, prompt: "hi" } }));

    // Frames are newline-delimited SSE, not a JSON array or NDJSON, and each
    // write is exactly one frame (the client parses on the blank-line boundary).
    expect(out.raw.startsWith("data: ")).toBe(true);
    expect(out.raw.endsWith("\n\n")).toBe(true);
    for (const chunk of out.chunks) {
      expect(chunk).toMatch(/^data: [^\n]*\n\n$/);
    }

    const evts = out.events();
    expect(evts.map((e) => e.type)).toEqual(["text", "text", "done"]);
    expect(evts.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe(
      "a cat on a mat",
    );
    const done = evts[2] as Extract<CapabilityStreamEvent, { type: "done" }>;
    expect(done.usage).toEqual({ inputTokens: 1200, outputTokens: 8 });
    expect(done.model).toBe(MODEL);
    expect(done.invocationId).toContain("photos:bedrock.invoke:");
    // The ledger was reconciled to actuals once the stream completed.
    expect(
      cap.ledger.some((r) => r.status === "committed" && r.unit === "tokens" && r.quantity === 8),
    ).toBe(true);
    expect(out.ended).toBe(true);
    setDbFactory(null);
  });

  it("emits a terminal error frame (not a truncated stream) when Bedrock fails mid-stream", async () => {
    __setBedrockInvokerForTests({
      async converse() {
        throw new Error("not used");
      },
      // eslint-disable-next-line require-yield
      async *converseStream() {
        throw new Error("bedrock stream exploded");
      },
    });
    const cap = capDb();
    setDbFactory(new StreamDsqlFactory(cap));
    const out = await run(streamEvent({ appId: "photos", body: { model: MODEL, prompt: "hi" } }));
    expect(soleError(out)).toMatchObject({ status: 502, error: "invoke_failed" });
    // A failed stream must not strand the reservation.
    expect(cap.ledger.every((r) => r.status === "released")).toBe(true);
    setDbFactory(null);
  });

  it("closes every DSQL client it opened, even on a rejected request", async () => {
    const factory = new StreamDsqlFactory(new InMemoryCapabilityDb({ grant: null }));
    setDbFactory(factory);
    await run(streamEvent({ appId: "photos", body: { model: MODEL, prompt: "hi" } }));
    expect(factory.opened).toBeGreaterThan(0);
    // grantClient closes itself inline; the rest go through the handler's
    // `finally`. Nothing may be left open when the invocation returns.
    expect(factory.closed).toBe(factory.opened);
    setDbFactory(null);
  });

  it("closes its clients after a fully-drained successful stream", async () => {
    const factory = new StreamDsqlFactory(capDb());
    setDbFactory(factory);
    await run(streamEvent({ appId: "photos", body: { model: MODEL, prompt: "hi" } }));
    expect(factory.closed).toBe(factory.opened);
    setDbFactory(null);
  });
});
