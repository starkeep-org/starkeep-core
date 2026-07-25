import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockClient } from "aws-sdk-client-mock";
import { LambdaClient, InvokeWithResponseStreamCommand } from "@aws-sdk/client-lambda";
import {
  invokeCapability,
  invokeCapabilityImage,
  invokeCapabilityStream,
  invokeCapabilityAsync,
  getCapabilityAsyncStatus,
  getGrantedCapabilities,
  reportCapabilityOutput,
  CapabilityUnavailableError,
  clearAppCredentialsCache,
  type CapabilityStreamEvent,
} from "../src/index.js";

let dir: string;
const APP_ID = "photos";
let fetchMock: ReturnType<typeof vi.fn>;

function writeCreds(over: Record<string, unknown> = {}): void {
  const credsDir = join(dir, "app-creds");
  mkdirSync(credsDir, { recursive: true });
  writeFileSync(
    join(credsDir, `${APP_ID}.json`),
    JSON.stringify({ appId: APP_ID, hmacSecret: "s".repeat(32), dataServerUrl: "http://127.0.0.1:9820", ...over }),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
  } as unknown as Response;
}

const lambdaMock = mockClient(LambdaClient);

/**
 * A Lambda RESPONSE_STREAM result whose `EventStream` carries the given SSE
 * events (the wire format the streaming handler writes: `data: <json>\n\n`).
 * The bytes are sliced into small `PayloadChunk`s so the test also exercises
 * the client's cross-chunk SSE-frame reassembly, and a terminal `InvokeComplete`
 * closes the stream — mirroring a real `InvokeWithResponseStream` response.
 */
function lambdaSseStream(events: unknown[], chunkSize = 7): { EventStream: AsyncIterable<unknown> } {
  const wire = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(wire);
  async function* gen(): AsyncGenerator<unknown> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield { PayloadChunk: { Payload: bytes.slice(i, i + chunkSize) } };
    }
    yield { InvokeComplete: {} };
  }
  return { EventStream: gen() };
}

/** The HTTP-shaped payload the client sends as the direct-invoke `Payload`. */
function lastStreamPayload(): {
  rawPath: string;
  requestContext: { http: { method: string } };
  headers: Record<string, string>;
  body: string;
} {
  const calls = lambdaMock.commandCalls(InvokeWithResponseStreamCommand);
  const input = calls[calls.length - 1]!.args[0].input as { Payload: Uint8Array };
  return JSON.parse(Buffer.from(input.Payload).toString("utf8"));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "capability-test-"));
  process.env.STARKEEP_DIR = dir;
  process.env.STARKEEP_CLOUD_DATA_BASE = "https://cloud.example.test";
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  clearAppCredentialsCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  lambdaMock.reset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.STARKEEP_CLOUD_DATA_BASE;
  delete process.env.STARKEEP_CLOUD_STREAM_FUNCTION;
  clearAppCredentialsCache();
});

describe("invokeCapability", () => {
  it("posts to the cloud capability route with the app's credentials and returns the result", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: "anthropic.claude-haiku-4-5",
        text: "a dog",
        usage: { inputTokens: 100, outputTokens: 5 },
        estCostMicros: 125,
        invocationId: "inv1",
      }),
    );
    const res = await invokeCapability(APP_ID, "bedrock.invoke", {
      model: "anthropic.claude-haiku-4-5",
      prompt: "caption",
      contentRef: { recordId: "rec1" },
    });
    expect(res.granted).toBe(true);
    if (res.granted && res.ok) {
      expect(res.text).toBe("a dog");
      expect(res.invocationId).toBe("inv1");
    } else {
      throw new Error("expected success");
    }
    // Hit the CLOUD base (not the local data server URL), under /apps/<appId>.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://cloud.example.test/apps/photos/capabilities/bedrock.invoke/invoke");
    // HMAC headers present.
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; method: string };
    expect(init.method).toBe("POST");
    expect(init.headers["X-Starkeep-App-Id"]).toBe(APP_ID);
    expect(init.headers["X-Starkeep-App-Sig"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns { granted: false } on a not_granted 403 (degraded mode, no throw)", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "not_granted" }));
    const res = await invokeCapability(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" });
    expect(res).toEqual({ granted: false });
  });

  it("surfaces a gate 429 as a structured failure, still granted", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(429, { error: "gate_exceeded", breaches: [] }));
    const res = await invokeCapability(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" });
    expect(res.granted).toBe(true);
    if (res.granted && !res.ok) {
      expect(res.status).toBe(429);
      expect(res.error).toBe("gate_exceeded");
    } else {
      throw new Error("expected failure");
    }
  });

  it("throws CapabilityUnavailableError when no cloud plane is configured", async () => {
    writeCreds();
    delete process.env.STARKEEP_CLOUD_DATA_BASE;
    clearAppCredentialsCache();
    await expect(
      invokeCapability(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" }),
    ).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });

  it("accepts the app's own dataServerUrl when it is already a cloud https endpoint", async () => {
    delete process.env.STARKEEP_CLOUD_DATA_BASE;
    writeCreds({ dataServerUrl: "https://cloud.example.test/apps/photos" });
    clearAppCredentialsCache();
    fetchMock.mockResolvedValue(jsonResponse(200, { text: "ok", usage: {}, model: "m" }));
    const res = await invokeCapability(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" });
    expect(res.granted).toBe(true);
  });
});

describe("invokeCapabilityImage (sync-s3, plan §3.8)", () => {
  it("returns the written output key(s) + derived cost on 200", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: "amazon.nova-canvas-v1:0",
        output: {
          bucket: "stk-files-1",
          keyPrefix: "apps/photos/syncable/capability-image/inv1",
          keys: ["apps/photos/syncable/capability-image/inv1/image-0.png"],
          totalBytes: 12345,
        },
        estCostMicros: 40_000, // $0.04
        invocationId: "inv1",
      }),
    );
    const res = await invokeCapabilityImage(APP_ID, "bedrock.invoke", {
      model: "amazon.nova-canvas-v1:0",
      prompt: "a watercolor cat",
    });
    expect(res.granted && res.ok).toBe(true);
    if (!res.granted || !res.ok) throw new Error("expected ok");
    expect(res.output.keys).toHaveLength(1);
    expect(res.output.totalBytes).toBe(12345);
    expect(res.estCostMicros).toBe(40_000);
    // Uses the synchronous /invoke route (not /invoke-async).
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/capabilities/bedrock.invoke/invoke");
    expect(url).not.toContain("invoke-async");
  });

  it("returns { granted: false } in degraded mode", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "not_granted" }));
    const res = await invokeCapabilityImage(APP_ID, "bedrock.invoke", {
      model: "amazon.nova-canvas-v1:0",
      prompt: "p",
    });
    expect(res.granted).toBe(false);
  });
});

describe("invokeCapabilityStream", () => {
  const STREAM_FN = "sk-dev-cloud-data-server-api-stream";

  it("directly invokes the streaming Lambda and yields text chunks then a done event", async () => {
    writeCreds();
    process.env.STARKEEP_CLOUD_STREAM_FUNCTION = STREAM_FN;
    lambdaMock.on(InvokeWithResponseStreamCommand).resolves(
      lambdaSseStream([
        { type: "text", text: "a " },
        { type: "text", text: "dog" },
        {
          type: "done",
          model: "anthropic.claude-haiku-4-5",
          usage: { inputTokens: 100, outputTokens: 2 },
          estCostMicros: 100,
          invocationId: "inv1",
        },
      ]),
    );
    const res = await invokeCapabilityStream(APP_ID, "bedrock.invoke", {
      model: "anthropic.claude-haiku-4-5",
      prompt: "caption",
      contentRef: { recordId: "rec1" },
    });
    expect(res.granted).toBe(true);
    if (!(res.granted && res.ok)) throw new Error("expected an open stream");

    const events: CapabilityStreamEvent[] = [];
    for await (const evt of res.stream) events.push(evt);
    const text = events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join("");
    expect(text).toBe("a dog");
    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done" && done.invocationId).toBe("inv1");

    // Invoked the configured stream function by NAME (no fetch / Function URL).
    expect(fetchMock).not.toHaveBeenCalled();
    const calls = lambdaMock.commandCalls(InvokeWithResponseStreamCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.FunctionName).toBe(STREAM_FN);
    // The HTTP-shaped payload targets the invoke-stream sub-path under /apps/<appId>
    // and carries the HMAC headers the handler re-verifies.
    const payload = lastStreamPayload();
    expect(payload.rawPath).toBe("/apps/photos/capabilities/bedrock.invoke/invoke-stream");
    expect(payload.requestContext.http.method).toBe("POST");
    expect(payload.headers["x-starkeep-app-id"]).toBe(APP_ID);
    expect(payload.headers["x-starkeep-app-sig"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns { granted: false } on a not_granted pre-flight (in-band error frame, no stream)", async () => {
    writeCreds();
    process.env.STARKEEP_CLOUD_STREAM_FUNCTION = STREAM_FN;
    lambdaMock
      .on(InvokeWithResponseStreamCommand)
      .resolves(lambdaSseStream([{ type: "error", status: 403, error: "not_granted" }]));
    const res = await invokeCapabilityStream(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" });
    expect(res).toEqual({ granted: false });
  });

  it("surfaces a gate 429 pre-flight as a structured failure, still granted", async () => {
    writeCreds();
    process.env.STARKEEP_CLOUD_STREAM_FUNCTION = STREAM_FN;
    lambdaMock
      .on(InvokeWithResponseStreamCommand)
      .resolves(lambdaSseStream([{ type: "error", status: 429, error: "gate_exceeded" }]));
    const res = await invokeCapabilityStream(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" });
    expect(res.granted).toBe(true);
    if (res.granted && !res.ok) {
      expect(res.status).toBe(429);
      expect(res.error).toBe("gate_exceeded");
    } else throw new Error("expected failure");
  });

  it("throws CapabilityUnavailableError when no streaming function is configured", async () => {
    writeCreds();
    delete process.env.STARKEEP_CLOUD_STREAM_FUNCTION;
    clearAppCredentialsCache();
    await expect(
      invokeCapabilityStream(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" }),
    ).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });
});

describe("invokeCapabilityAsync (plan §3.8)", () => {
  it("starts a job and returns the running result + output location on 202", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(
      jsonResponse(202, {
        invocationId: "inv-async-1",
        status: "running",
        output: { bucket: "stk-files-1", keyPrefix: "apps/photos/syncable/capability-async/inv-async-1" },
      }),
    );
    const res = await invokeCapabilityAsync(APP_ID, "bedrock.invoke", {
      model: "amazon.nova-reel-v1:1",
      prompt: "a cat surfing",
      generation: { durationSeconds: 6 },
    });
    expect(res.granted && res.ok).toBe(true);
    if (res.granted && res.ok) {
      expect(res.invocationId).toBe("inv-async-1");
      expect(res.status).toBe("running");
      expect(res.output.keyPrefix).toContain("capability-async");
    }
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://cloud.example.test/apps/photos/capabilities/bedrock.invoke/invoke-async");
  });

  it("returns { granted: false } when the app has no grant", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "not_granted" }));
    const res = await invokeCapabilityAsync(APP_ID, "bedrock.invoke", { model: "amazon.nova-reel-v1:1", prompt: "p" });
    expect(res).toEqual({ granted: false });
  });

  it("surfaces a text-model rejection as a structured failure", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "output_not_async", model: "anthropic.claude-haiku-4-5" }));
    const res = await invokeCapabilityAsync(APP_ID, "bedrock.invoke", { model: "anthropic.claude-haiku-4-5", prompt: "p" });
    expect(res.granted && !res.ok).toBe(true);
    if (res.granted && !res.ok) expect(res.error).toBe("output_not_async");
  });
});

describe("getCapabilityAsyncStatus (plan §3.8)", () => {
  it("maps running / completed (with output keys) / failed", async () => {
    writeCreds();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "running" }));
    const running = await getCapabilityAsyncStatus(APP_ID, "bedrock.invoke", "inv1");
    expect(running.granted && running.ok && running.status).toBe("running");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://cloud.example.test/apps/photos/capabilities/bedrock.invoke/async/inv1");

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        status: "completed",
        output: { bucket: "stk-files-1", keyPrefix: "apps/photos/syncable/capability-async/inv1", keys: ["output.mp4"], totalBytes: 2500000 },
      }),
    );
    const done = await getCapabilityAsyncStatus(APP_ID, "bedrock.invoke", "inv1");
    expect(done.granted && done.ok && done.status).toBe("completed");
    if (done.granted && done.ok && done.status === "completed") {
      expect(done.output.keys).toEqual(["output.mp4"]);
      expect(done.output.totalBytes).toBe(2500000);
    }

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "failed", error: "content filtered" }));
    const failed = await getCapabilityAsyncStatus(APP_ID, "bedrock.invoke", "inv1");
    expect(failed.granted && failed.ok && failed.status).toBe("failed");
    if (failed.granted && failed.ok && failed.status === "failed") expect(failed.error).toBe("content filtered");
  });

  it("URL-encodes the invocationId (colons from the id become %3A)", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "running" }));
    await getCapabilityAsyncStatus(APP_ID, "bedrock.invoke", "photos:bedrock.invoke:async:1:ab");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/async/photos%3Abedrock.invoke%3Aasync%3A1%3Aab");
  });
});

describe("getGrantedCapabilities", () => {
  it("lists grants; returns [] with no cloud plane instead of throwing", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { capabilities: [{ name: "bedrock.invoke", models: ["m"], reports: [] }] }),
    );
    const caps = await getGrantedCapabilities(APP_ID);
    expect(caps).toEqual([{ name: "bedrock.invoke", models: ["m"], reports: [] }]);

    delete process.env.STARKEEP_CLOUD_DATA_BASE;
    clearAppCredentialsCache();
    expect(await getGrantedCapabilities(APP_ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stream decoding edge cases
// ---------------------------------------------------------------------------

/** A Lambda event stream built from raw wire bytes (not well-formed frames). */
function lambdaRawStream(wire: string, tail: unknown[] = [{ InvokeComplete: {} }]) {
  const bytes = new TextEncoder().encode(wire);
  async function* gen(): AsyncGenerator<unknown> {
    if (bytes.length > 0) yield { PayloadChunk: { Payload: bytes } };
    for (const t of tail) yield t;
  }
  return { EventStream: gen() };
}

describe("invokeCapabilityStream — stream decoding edge cases", () => {
  const STREAM_FN = "sk-dev-cloud-data-server-api-stream";

  beforeEach(() => {
    writeCreds();
    process.env.STARKEEP_CLOUD_STREAM_FUNCTION = STREAM_FN;
  });

  const start = () =>
    invokeCapabilityStream(APP_ID, "bedrock.invoke", { model: "m", prompt: "p" });

  it("reports no_stream when the invoke returns no EventStream at all", async () => {
    lambdaMock.on(InvokeWithResponseStreamCommand).resolves({});
    const res = await start();
    expect(res.granted).toBe(true);
    if (res.granted && !res.ok) {
      expect(res.status).toBe(502);
      expect(res.error).toBe("no_stream");
    } else throw new Error("expected failure");
  });

  it("reports empty_stream when the stream closes without a single frame", async () => {
    lambdaMock.on(InvokeWithResponseStreamCommand).resolves(lambdaRawStream(""));
    const res = await start();
    if (res.granted && !res.ok) {
      expect(res.error).toBe("empty_stream");
      expect(res.status).toBe(502);
    } else throw new Error("expected failure");
  });

  it("turns a Lambda-level failure at completion into a synthetic error event", async () => {
    // A function error / throttle arrives on InvokeComplete, not as an SSE
    // frame — without this mapping the caller would just see a short stream.
    lambdaMock.on(InvokeWithResponseStreamCommand).resolves(
      lambdaRawStream("", [
        { InvokeComplete: { ErrorCode: "Unhandled", ErrorDetails: "Runtime exited" } },
      ]),
    );
    const res = await start();
    if (res.granted && !res.ok) {
      expect(res.error).toBe("stream_invoke_failed");
      expect(res.status).toBe(502);
      expect(res.detail).toBe("Runtime exited");
    } else throw new Error("expected failure");
  });

  it("falls back to the ErrorCode when no ErrorDetails are supplied", async () => {
    lambdaMock
      .on(InvokeWithResponseStreamCommand)
      .resolves(lambdaRawStream("", [{ InvokeComplete: { ErrorCode: "Throttled" } }]));
    const res = await start();
    if (res.granted && !res.ok) {
      expect(res.detail).toBe("Throttled");
    } else throw new Error("expected failure");
  });

  it("surfaces a Lambda failure that arrives AFTER a partial stream as a mid-stream error", async () => {
    lambdaMock.on(InvokeWithResponseStreamCommand).resolves(
      lambdaRawStream(`data: ${JSON.stringify({ type: "text", text: "a" })}\n\n`, [
        { InvokeComplete: { ErrorCode: "Unhandled" } },
      ]),
    );
    const res = await start();
    if (!(res.granted && res.ok)) throw new Error("expected an open stream");
    const events: CapabilityStreamEvent[] = [];
    for await (const evt of res.stream) events.push(evt);
    expect(events.map((e) => e.type)).toEqual(["text", "error"]);
  });

  it("skips a malformed frame instead of aborting the whole stream", async () => {
    const wire =
      `data: ${JSON.stringify({ type: "text", text: "a " })}\n\n` +
      `data: {not json\n\n` +
      `data: ${JSON.stringify({ type: "text", text: "dog" })}\n\n` +
      `data: ${JSON.stringify({ type: "done", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, estCostMicros: 0, invocationId: "i" })}\n\n`;
    lambdaMock.on(InvokeWithResponseStreamCommand).resolves(lambdaRawStream(wire));
    const res = await start();
    if (!(res.granted && res.ok)) throw new Error("expected an open stream");
    const events: CapabilityStreamEvent[] = [];
    for await (const evt of res.stream) events.push(evt);
    expect(events.map((e) => e.type)).toEqual(["text", "text", "done"]);
    expect(
      events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join(""),
    ).toBe("a dog");
  });

  it("ignores non-data lines and blank data payloads inside a frame", async () => {
    const wire =
      `: keep-alive comment\ndata: ${JSON.stringify({ type: "text", text: "hi" })}\n\n` +
      `data:\n\n` +
      `event: ping\n\n`;
    lambdaMock.on(InvokeWithResponseStreamCommand).resolves(lambdaRawStream(wire));
    const res = await start();
    if (!(res.granted && res.ok)) throw new Error("expected an open stream");
    const events: CapabilityStreamEvent[] = [];
    for await (const evt of res.stream) events.push(evt);
    expect(events).toEqual([{ type: "text", text: "hi" }]);
  });

  it("drops a trailing partial frame that never reached its blank-line terminator", async () => {
    const wire =
      `data: ${JSON.stringify({ type: "text", text: "ok" })}\n\n` +
      `data: {"type":"text","text":"trunc`;
    lambdaMock.on(InvokeWithResponseStreamCommand).resolves(lambdaRawStream(wire));
    const res = await start();
    if (!(res.granted && res.ok)) throw new Error("expected an open stream");
    const events: CapabilityStreamEvent[] = [];
    for await (const evt of res.stream) events.push(evt);
    expect(events).toEqual([{ type: "text", text: "ok" }]);
  });

  it("reassembles a multi-byte character split across chunk boundaries", async () => {
    // The decoder is used in streaming mode precisely so a UTF-8 sequence cut
    // in half by a chunk boundary isn't turned into replacement characters.
    lambdaMock.on(InvokeWithResponseStreamCommand).resolves(
      lambdaSseStream([{ type: "text", text: "wörld — ok" }], 3),
    );
    const res = await start();
    if (!(res.granted && res.ok)) throw new Error("expected an open stream");
    const events: CapabilityStreamEvent[] = [];
    for await (const evt of res.stream) events.push(evt);
    expect(events).toEqual([{ type: "text", text: "wörld — ok" }]);
  });

  it("maps any other leading error frame to a structured failure with its status", async () => {
    lambdaMock
      .on(InvokeWithResponseStreamCommand)
      .resolves(lambdaSseStream([{ type: "error", status: 404, error: "not_found" }]));
    const res = await start();
    if (res.granted && !res.ok) {
      expect(res.status).toBe(404);
      expect(res.error).toBe("not_found");
    } else throw new Error("expected failure");
  });
});

// ---------------------------------------------------------------------------
// reportCapabilityOutput
// ---------------------------------------------------------------------------

describe("reportCapabilityOutput", () => {
  it("posts the invocation's app-measured output quantities to the report route", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, recorded: 1 }));
    await reportCapabilityOutput(APP_ID, "bedrock.invoke", "inv-1", {
      "output:pixels": 4_000_000,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }];
    expect(url).toBe("https://cloud.example.test/apps/photos/capabilities/bedrock.invoke/report");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      invocationId: "inv-1",
      reports: { "output:pixels": 4_000_000 },
    });
    // Signed like every other app→cloud call.
    expect(init.headers["X-Starkeep-App-Sig"] ?? init.headers["x-starkeep-app-sig"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("URL-encodes the capability name", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, recorded: 0 }));
    await reportCapabilityOutput(APP_ID, "vendor/cap name", "inv-1", {});
    expect(fetchMock.mock.calls[0][0] as string).toContain(
      "/capabilities/vendor%2Fcap%20name/report",
    );
  });

  it("is best-effort: a non-200 response does not throw (the report never hard-blocks)", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(404, { error: "unknown_invocation" }));
    await expect(
      reportCapabilityOutput(APP_ID, "bedrock.invoke", "gone", { "output:frames": 30 }),
    ).resolves.toBeUndefined();
  });

  it("posts an empty reports object without special-casing it", async () => {
    writeCreds();
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, recorded: 0 }));
    await reportCapabilityOutput(APP_ID, "bedrock.invoke", "inv-1", {});
    expect(JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).reports).toEqual({});
  });
});
