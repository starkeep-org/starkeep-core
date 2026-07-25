/**
 * `bedrock-client.ts` — the AWS-facing halves of the invokers.
 *
 * The pure body builders are covered elsewhere; what's exercised here is
 * everything that touches a Bedrock RESPONSE, where a wrong default is silent:
 * missing usage counting as 0 tokens (a free invoke, as far as the ledger is
 * concerned), an error body that must throw rather than yield zero images, and
 * `normalizeAsyncStatus`'s deliberate unknown→InProgress fail-safe — which is
 * what stops an unrecognized status from committing a reservation early.
 *
 * The Bedrock runtime client is aws-sdk-client-mock'ed; no AWS.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  StartAsyncInvokeCommand,
  GetAsyncInvokeCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  makeConverseInvoker,
  makeImageInvoker,
  makeAsyncInvoker,
  type BedrockInvokeRequest,
  type BedrockStreamEvent,
} from "../src/bedrock-client.js";

const bedrockMock = mockClient(BedrockRuntimeClient);

const CREDS = { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" };

function req(over: Partial<BedrockInvokeRequest> = {}): BedrockInvokeRequest {
  return {
    target: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    region: "us-east-1",
    provider: "anthropic",
    prompt: "Describe this image.",
    maxTokens: 100,
    credentials: CREDS,
    ...over,
  };
}

beforeEach(() => {
  bedrockMock.reset();
});

/** The `content` array of the single user message on the last Converse call. */
function sentContent(command: typeof ConverseCommand | typeof ConverseStreamCommand) {
  const calls = bedrockMock.commandCalls(command as typeof ConverseCommand);
  const input = calls[0]!.args[0].input as unknown as { messages: Array<{ content: unknown[] }> };
  return input.messages[0]!.content;
}

// ---------------------------------------------------------------------------
// buildContent — inline bytes vs S3 location
// ---------------------------------------------------------------------------

describe("request content assembly", () => {
  beforeEach(() => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  });

  it("sends the prompt as the first content block", async () => {
    await makeConverseInvoker().converse(req());
    expect(sentContent(ConverseCommand)).toEqual([{ text: "Describe this image." }]);
  });

  it("attaches an INLINE image as source.bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await makeConverseInvoker().converse(req({ images: [{ format: "jpeg", bytes }] }));
    expect(sentContent(ConverseCommand)).toEqual([
      { text: "Describe this image." },
      { image: { format: "jpeg", source: { bytes } } },
    ]);
  });

  it("attaches an S3-LOCATION image as source.s3Location, carrying bucketOwner", async () => {
    await makeConverseInvoker().converse(
      req({
        images: [
          { format: "png", s3Uri: "s3://stk-files-1/shared/image/ab/cd", bucketOwner: "111122223333" },
        ],
      }),
    );
    expect(sentContent(ConverseCommand)[1]).toEqual({
      image: {
        format: "png",
        source: {
          s3Location: { uri: "s3://stk-files-1/shared/image/ab/cd", bucketOwner: "111122223333" },
        },
      },
    });
  });

  it("omits bucketOwner when the caller didn't pin one", async () => {
    await makeConverseInvoker().converse(
      req({ images: [{ format: "png", s3Uri: "s3://b/k" }] }),
    );
    const block = sentContent(ConverseCommand)[1] as {
      image: { source: { s3Location: Record<string, unknown> } };
    };
    expect(block.image.source.s3Location).toEqual({ uri: "s3://b/k" });
  });

  it("passes the model target and the maxTokens ceiling through", async () => {
    await makeConverseInvoker().converse(req({ maxTokens: 42 }));
    const input = bedrockMock.commandCalls(ConverseCommand)[0]!.args[0].input as {
      modelId: string;
      inferenceConfig: { maxTokens: number };
    };
    expect(input.modelId).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(input.inferenceConfig.maxTokens).toBe(42);
  });

  it("attaches multiple images in order", async () => {
    await makeConverseInvoker().converse(
      req({
        images: [
          { format: "jpeg", bytes: new Uint8Array([1]) },
          { format: "png", s3Uri: "s3://b/k2" },
        ],
      }),
    );
    expect(sentContent(ConverseCommand)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Converse response parsing
// ---------------------------------------------------------------------------

describe("converse response parsing", () => {
  it("joins every text block into one string", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "a cat " }, { text: "on a mat" }] } },
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
    const out = await makeConverseInvoker().converse(req());
    expect(out).toEqual({ text: "a cat on a mat", inputTokens: 12, outputTokens: 3 });
  });

  it("ignores non-text blocks when joining", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: {
        message: {
          role: "assistant",
          content: [
            { text: "hello" },
            { toolUse: { name: "x", toolUseId: "1", input: {} } },
            { text: " world" },
          ],
        },
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    expect((await makeConverseInvoker().converse(req())).text).toBe("hello world");
  });

  it("returns empty text when the response carries no output message", async () => {
    bedrockMock.on(ConverseCommand).resolves({ usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 } });
    const out = await makeConverseInvoker().converse(req());
    expect(out.text).toBe("");
    expect(out.inputTokens).toBe(5);
  });

  it("counts MISSING usage as zero rather than NaN (a NaN would poison the ledger)", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
    });
    const out = await makeConverseInvoker().converse(req());
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
    expect(Number.isFinite(out.inputTokens)).toBe(true);
  });

  it("counts a partially-reported usage record's missing half as zero", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
      usage: { inputTokens: 7 } as never,
    });
    const out = await makeConverseInvoker().converse(req());
    expect(out).toMatchObject({ inputTokens: 7, outputTokens: 0 });
  });

  it("propagates an SDK failure to the caller (which releases the reservation)", async () => {
    bedrockMock.on(ConverseCommand).rejects(new Error("ThrottlingException"));
    await expect(makeConverseInvoker().converse(req())).rejects.toThrow("ThrottlingException");
  });
});

// ---------------------------------------------------------------------------
// ConverseStream parsing
// ---------------------------------------------------------------------------

/** Turn an array of SDK stream events into the async iterable the SDK returns. */
function sdkStream(events: unknown[]) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

async function drain(it: AsyncIterable<BedrockStreamEvent>): Promise<BedrockStreamEvent[]> {
  const out: BedrockStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("converseStream parsing", () => {
  it("yields a text event per delta and a terminal done carrying the metadata usage", async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({
      stream: sdkStream([
        { contentBlockDelta: { delta: { text: "a cat " } } },
        { contentBlockDelta: { delta: { text: "on a mat" } } },
        { metadata: { usage: { inputTokens: 1200, outputTokens: 8, totalTokens: 1208 } } },
      ]) as never,
    });
    const events = await drain(makeConverseInvoker().converseStream(req()));
    expect(events).toEqual([
      { type: "text", text: "a cat " },
      { type: "text", text: "on a mat" },
      { type: "done", inputTokens: 1200, outputTokens: 8 },
    ]);
  });

  it("skips frames that are neither a text delta nor usage metadata", async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({
      stream: sdkStream([
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { delta: { toolUse: { input: "{}" } } } },
        { contentBlockDelta: { delta: { text: "hi" } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: "end_turn" } },
      ]) as never,
    });
    const events = await drain(makeConverseInvoker().converseStream(req()));
    expect(events.filter((e) => e.type === "text")).toEqual([{ type: "text", text: "hi" }]);
  });

  it("still emits a done event (zeroed) when the stream carried no usage metadata", async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({
      stream: sdkStream([{ contentBlockDelta: { delta: { text: "hi" } } }]) as never,
    });
    const events = await drain(makeConverseInvoker().converseStream(req()));
    expect(events[events.length - 1]).toEqual({ type: "done", inputTokens: 0, outputTokens: 0 });
  });

  it("emits a done event for an entirely empty stream", async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({ stream: sdkStream([]) as never });
    expect(await drain(makeConverseInvoker().converseStream(req()))).toEqual([
      { type: "done", inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("tolerates a response with no stream at all", async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({});
    expect(await drain(makeConverseInvoker().converseStream(req()))).toEqual([
      { type: "done", inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("keeps the LAST usage record when metadata arrives more than once", async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({
      stream: sdkStream([
        { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
        { metadata: { usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } } },
      ]) as never,
    });
    const events = await drain(makeConverseInvoker().converseStream(req()));
    expect(events[0]).toEqual({ type: "done", inputTokens: 10, outputTokens: 20 });
  });

  it("sends the same content assembly as the buffered path", async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({ stream: sdkStream([]) as never });
    await drain(
      makeConverseInvoker().converseStream(req({ images: [{ format: "png", s3Uri: "s3://b/k" }] })),
    );
    expect(sentContent(ConverseStreamCommand)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Sync image generation (Nova Canvas)
// ---------------------------------------------------------------------------

/** Nova Canvas returns a JSON body of base64 images. */
function canvasBody(obj: unknown): { body: Uint8Array } {
  return { body: new Uint8Array(Buffer.from(JSON.stringify(obj), "utf8")) };
}

const imageReq = {
  target: "amazon.nova-canvas-v1:0",
  region: "us-east-1",
  provider: "amazon" as const,
  prompt: "a watercolor cat",
  credentials: CREDS,
};

describe("sync image generation", () => {
  it("decodes the base64 images from the response body", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    bedrockMock
      .on(InvokeModelCommand)
      .resolves(canvasBody({ images: [png.toString("base64")] }) as never);
    const out = await makeImageInvoker().generateImage(imageReq);
    expect(out.format).toBe("png");
    expect(out.images).toHaveLength(1);
    expect(Buffer.from(out.images[0]!)).toEqual(png);
  });

  it("decodes every returned image", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(
      canvasBody({
        images: [Buffer.from([1]).toString("base64"), Buffer.from([2, 3]).toString("base64")],
      }) as never,
    );
    const out = await makeImageInvoker().generateImage(imageReq);
    expect(out.images.map((i) => i.byteLength)).toEqual([1, 2]);
  });

  it("THROWS on an error body rather than returning zero images", async () => {
    // A silent empty result would look like a successful (billed) invoke.
    bedrockMock
      .on(InvokeModelCommand)
      .resolves(canvasBody({ error: "content filtered", images: [] }) as never);
    await expect(makeImageInvoker().generateImage(imageReq)).rejects.toThrow(
      /Nova Canvas error: content filtered/,
    );
  });

  it("throws when the body carries no images at all", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(canvasBody({}) as never);
    await expect(makeImageInvoker().generateImage(imageReq)).rejects.toThrow(
      /returned no images/,
    );
  });

  it("throws on an explicitly empty images array", async () => {
    bedrockMock.on(InvokeModelCommand).resolves(canvasBody({ images: [] }) as never);
    await expect(makeImageInvoker().generateImage(imageReq)).rejects.toThrow(/no images/);
  });

  it("sends the generation body as JSON on the InvokeModel request", async () => {
    bedrockMock
      .on(InvokeModelCommand)
      .resolves(canvasBody({ images: [Buffer.from([1]).toString("base64")] }) as never);
    await makeImageInvoker().generateImage({ ...imageReq, generation: { width: 512, seed: 7 } });
    const input = bedrockMock.commandCalls(InvokeModelCommand)[0]!.args[0].input as {
      modelId: string;
      contentType: string;
      body: string;
    };
    expect(input.modelId).toBe("amazon.nova-canvas-v1:0");
    expect(input.contentType).toBe("application/json");
    const body = JSON.parse(input.body) as {
      taskType: string;
      imageGenerationConfig: { width: number; seed: number };
    };
    expect(body.taskType).toBe("TEXT_IMAGE");
    expect(body.imageGenerationConfig).toMatchObject({ width: 512, seed: 7 });
  });
});

// ---------------------------------------------------------------------------
// Async start / status
// ---------------------------------------------------------------------------

const asyncStart = {
  target: "amazon.nova-reel-v1:1",
  region: "us-east-1",
  provider: "amazon" as const,
  prompt: "a cat surfing",
  outputS3Uri: "s3://stk-files-1/apps/photos/syncable/capability-async/inv-1/",
  outputBucketOwner: "111122223333",
  credentials: CREDS,
};

describe("async start", () => {
  it("returns the invocation ARN and passes the S3 output config through", async () => {
    bedrockMock.on(StartAsyncInvokeCommand).resolves({ invocationArn: "arn:aws:bedrock:...:job-1" });
    const out = await makeAsyncInvoker().startAsync(asyncStart);
    expect(out).toEqual({ invocationArn: "arn:aws:bedrock:...:job-1" });
    const input = bedrockMock.commandCalls(StartAsyncInvokeCommand)[0]!.args[0].input as unknown as {
      modelId: string;
      outputDataConfig: { s3OutputDataConfig: { s3Uri: string; bucketOwner?: string } };
    };
    expect(input.modelId).toBe("amazon.nova-reel-v1:1");
    expect(input.outputDataConfig.s3OutputDataConfig).toEqual({
      s3Uri: asyncStart.outputS3Uri,
      bucketOwner: "111122223333",
    });
  });

  it("THROWS when the response carries no invocationArn (an unpollable job)", async () => {
    // Without the ARN the job could never be reconciled — its reservation would
    // sit reserved forever, so failing loudly is the only safe outcome.
    bedrockMock.on(StartAsyncInvokeCommand).resolves({});
    await expect(makeAsyncInvoker().startAsync(asyncStart)).rejects.toThrow(
      /returned no invocationArn/,
    );
  });

  it("omits bucketOwner when none was supplied", async () => {
    bedrockMock.on(StartAsyncInvokeCommand).resolves({ invocationArn: "arn:x" });
    const { outputBucketOwner: _drop, ...noOwner } = asyncStart;
    await makeAsyncInvoker().startAsync(noOwner);
    const input = bedrockMock.commandCalls(StartAsyncInvokeCommand)[0]!.args[0]
      .input as unknown as { outputDataConfig: { s3OutputDataConfig: Record<string, unknown> } };
    expect(input.outputDataConfig.s3OutputDataConfig).toEqual({ s3Uri: asyncStart.outputS3Uri });
  });
});

describe("async status normalization", () => {
  const status = () =>
    makeAsyncInvoker().getAsyncStatus({
      invocationArn: "arn:x",
      region: "us-east-1",
      credentials: CREDS,
    });

  it("passes Completed and Failed through", async () => {
    bedrockMock.on(GetAsyncInvokeCommand).resolves({ status: "Completed" });
    expect((await status()).status).toBe("Completed");
    bedrockMock.reset();
    bedrockMock.on(GetAsyncInvokeCommand).resolves({ status: "Failed" });
    expect((await status()).status).toBe("Failed");
  });

  it("maps InProgress and every UNKNOWN status to InProgress (fail-safe)", async () => {
    // The fail-safe direction matters: an unrecognized status must never be
    // read as Completed (which would commit the reservation and hand the app an
    // output that isn't there) nor as Failed (which would release it early).
    for (const raw of ["InProgress", "Scheduled", "Cancelled", "COMPLETED", "", undefined]) {
      bedrockMock.reset();
      bedrockMock.on(GetAsyncInvokeCommand).resolves({ status: raw as never });
      expect((await status()).status, String(raw)).toBe("InProgress");
    }
  });

  it("carries the failure message and the output URI when present", async () => {
    bedrockMock.on(GetAsyncInvokeCommand).resolves({
      status: "Failed",
      failureMessage: "content filtered",
      outputDataConfig: { s3OutputDataConfig: { s3Uri: "s3://b/prefix/" } },
    });
    expect(await status()).toEqual({
      status: "Failed",
      failureMessage: "content filtered",
      outputS3Uri: "s3://b/prefix/",
    });
  });

  it("omits absent optional fields rather than emitting undefined keys", async () => {
    bedrockMock.on(GetAsyncInvokeCommand).resolves({ status: "Completed" });
    expect(await status()).toEqual({ status: "Completed" });
  });

  it("polls the ARN it was given", async () => {
    bedrockMock.on(GetAsyncInvokeCommand).resolves({ status: "InProgress" });
    await status();
    expect(bedrockMock.commandCalls(GetAsyncInvokeCommand)[0]!.args[0].input).toEqual({
      invocationArn: "arn:x",
    });
  });
});
