/**
 * Bedrock invocation for the capability broker (plan §3.6).
 *
 * The broker speaks to models through the Bedrock **Converse API**, which
 * normalizes request/response across providers for the text/vision path — this
 * is what makes the multi-provider adapter set (Anthropic, OpenAI, Kimi, Qwen,
 * GLM) cheap. Raw `InvokeModel` with provider-specific bodies is the fallback
 * for models Converse doesn't cover; the `providerAdapter` seam below is where
 * that per-provider divergence lands. The wired increment ships the Converse
 * path for every provider and returns TEXT output only (§3.8 defers non-text).
 *
 * `BedrockInvoker` is a test seam: the route depends on the interface, so tests
 * inject a fake and never call AWS, while production uses the Converse client
 * constructed with the assumed capability-role credentials.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  StartAsyncInvokeCommand,
  GetAsyncInvokeCommand,
  type ContentBlock,
  type ImageFormat,
} from "@aws-sdk/client-bedrock-runtime";
import type { ModelProvider } from "@starkeep/protocol-primitives";

/**
 * An image fed to Bedrock, delivered one of two ways (plan §3.4, "pick per
 * request size"):
 *  - INLINE: the CDS read the bytes under the app role and base64-inlines them
 *    (small single images — the capability role needs no S3 access).
 *  - S3 LOCATION: the CDS passes the object URI and Bedrock reads it directly
 *    under the capability role (large/many images that would blow the inline
 *    request-size/timeout limit). Reached under a single-key session policy the
 *    broker attaches on the assume — see api-handler getCapabilityBrokerCreds.
 */
export type BedrockImageInput =
  | { format: ImageFormat; bytes: Uint8Array } // "png" | "jpeg" | "gif" | "webp"
  | { format: ImageFormat; s3Uri: string; bucketOwner?: string };

export interface BedrockInvokeRequest {
  /** The Bedrock target: inference profile id when present, else the model id. */
  target: string;
  region: string;
  provider: ModelProvider;
  prompt: string;
  images?: BedrockImageInput[];
  maxTokens: number;
  /** Assumed capability-role credentials (single-hop, per request). */
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
  };
}

export interface BedrockInvokeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** A streamed text chunk followed by a terminal usage record. */
export interface BedrockStreamEvent {
  type: "text" | "done";
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface BedrockInvoker {
  converse(req: BedrockInvokeRequest): Promise<BedrockInvokeResult>;
  converseStream(req: BedrockInvokeRequest): AsyncIterable<BedrockStreamEvent>;
}

/** Which invoke mode a provider's models use. All five ship on the Converse
 * path in this increment; a provider whose models Converse doesn't cover flips
 * to "invokeModel" here (a later increment) without any IAM change. */
export function providerAdapterMode(_provider: ModelProvider): "converse" | "invokeModel" {
  return "converse";
}

function buildContent(req: BedrockInvokeRequest): ContentBlock[] {
  const content: ContentBlock[] = [{ text: req.prompt }];
  for (const img of req.images ?? []) {
    if ("bytes" in img) {
      content.push({ image: { format: img.format, source: { bytes: img.bytes } } });
    } else {
      // S3-location delivery: Bedrock reads the object under the capability
      // role (narrowed to this key by the per-assume session policy).
      content.push({
        image: {
          format: img.format,
          source: {
            s3Location: {
              uri: img.s3Uri,
              ...(img.bucketOwner ? { bucketOwner: img.bucketOwner } : {}),
            },
          },
        },
      });
    }
  }
  return content;
}

export function makeConverseInvoker(): BedrockInvoker {
  function clientFor(req: BedrockInvokeRequest): BedrockRuntimeClient {
    return new BedrockRuntimeClient({ region: req.region, credentials: req.credentials });
  }

  return {
    async converse(req) {
      const client = clientFor(req);
      const out = await client.send(
        new ConverseCommand({
          modelId: req.target,
          messages: [{ role: "user", content: buildContent(req) }],
          inferenceConfig: { maxTokens: req.maxTokens },
        }),
      );
      const text = (out.output?.message?.content ?? [])
        .map((b) => ("text" in b ? b.text : ""))
        .join("");
      return {
        text,
        inputTokens: out.usage?.inputTokens ?? 0,
        outputTokens: out.usage?.outputTokens ?? 0,
      };
    },

    async *converseStream(req) {
      const client = clientFor(req);
      const out = await client.send(
        new ConverseStreamCommand({
          modelId: req.target,
          messages: [{ role: "user", content: buildContent(req) }],
          inferenceConfig: { maxTokens: req.maxTokens },
        }),
      );
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const evt of out.stream ?? []) {
        if (evt.contentBlockDelta?.delta && "text" in evt.contentBlockDelta.delta) {
          yield { type: "text", text: evt.contentBlockDelta.delta.text };
        }
        if (evt.metadata?.usage) {
          inputTokens = evt.metadata.usage.inputTokens ?? 0;
          outputTokens = evt.metadata.usage.outputTokens ?? 0;
        }
      }
      yield { type: "done", inputTokens, outputTokens };
    },
  };
}

// Test seam: the route resolves the invoker through this so a test can inject a
// fake without touching AWS.
let invokerOverride: BedrockInvoker | null = null;
export function __setBedrockInvokerForTests(invoker: BedrockInvoker | null): void {
  invokerOverride = invoker;
}
let defaultInvoker: BedrockInvoker | null = null;
export function getBedrockInvoker(): BedrockInvoker {
  if (invokerOverride) return invokerOverride;
  if (!defaultInvoker) defaultInvoker = makeConverseInvoker();
  return defaultInvoker;
}

// ---------------------------------------------------------------------------
// Synchronous image generation (InvokeModel) — plan §3.8 `sync-s3` channel
// ---------------------------------------------------------------------------
//
// Cheap image generation (Amazon Nova Canvas) is SYNCHRONOUS: a single
// InvokeModel returns the image bytes (base64) in the response body — there is no
// StartAsyncInvoke / S3-output config for it. So unlike the async video path, the
// bytes come back HERE, through the CDS, which then writes them to the app's S3
// area under the APP role (the capability role stays write-free). This is raw
// InvokeModel with a provider-specific body (Converse doesn't cover generation),
// behind its own {@link BedrockImageInvoker} test seam.

/** Generation parameters for a synchronous image request. All CDS-known pre-call,
 * so the reservation/cost math stays CDS-derived. `numberOfImages` is capped at 1
 * for this increment (plan §3.8). */
export interface ImageGenerationParams {
  width?: number;
  height?: number;
  cfgScale?: number;
  seed?: number;
  quality?: "standard" | "premium";
}

export interface BedrockImageGenRequest {
  /** Model id to invoke (Nova Canvas takes the bare foundation-model id). */
  target: string;
  region: string;
  provider: ModelProvider;
  prompt: string;
  /** Optional conditioning image (inline or S3) for image-to-image. */
  image?: BedrockImageInput;
  generation?: ImageGenerationParams;
  credentials: BedrockInvokeRequest["credentials"];
}

export interface BedrockImageGenResult {
  /** Decoded image bytes, one per generated image. */
  images: Uint8Array[];
  /** Output image format (Nova Canvas returns PNG). */
  format: ImageFormat;
}

export interface BedrockImageInvoker {
  generateImage(req: BedrockImageGenRequest): Promise<BedrockImageGenResult>;
}

/**
 * Build the provider-specific InvokeModel body for a synchronous image request.
 * Pure and testable. Only the Amazon Nova Canvas `TEXT_IMAGE` shape is wired in
 * this increment (§3.8); any other provider throws until an adapter is added —
 * with NO IAM change (the boundary is all-Bedrock, §3.3).
 */
export function buildImageModelInput(req: BedrockImageGenRequest): Record<string, unknown> {
  if (req.provider !== "amazon") {
    throw new Error(`sync image generation not supported for provider "${req.provider}"`);
  }
  const g = req.generation ?? {};
  const textToImageParams: Record<string, unknown> = { text: req.prompt };
  if (req.image && "bytes" in req.image) {
    // Nova Canvas conditioning images are inline base64 (image-to-image).
    textToImageParams.conditionImage = Buffer.from(req.image.bytes).toString("base64");
  }
  return {
    taskType: "TEXT_IMAGE",
    textToImageParams,
    imageGenerationConfig: {
      // numberOfImages capped at 1 for this increment (one image per request).
      numberOfImages: 1,
      width: g.width ?? 1024,
      height: g.height ?? 1024,
      cfgScale: g.cfgScale ?? 6.5,
      quality: g.quality ?? "standard",
      seed: g.seed ?? 0,
    },
  };
}

export function makeImageInvoker(): BedrockImageInvoker {
  return {
    async generateImage(req) {
      const client = new BedrockRuntimeClient({ region: req.region, credentials: req.credentials });
      const out = await client.send(
        new InvokeModelCommand({
          modelId: req.target,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(buildImageModelInput(req)),
        }),
      );
      const decoded = JSON.parse(Buffer.from(out.body).toString("utf8")) as {
        images?: string[];
        error?: string | null;
      };
      if (decoded.error) throw new Error(`Nova Canvas error: ${decoded.error}`);
      const images = (decoded.images ?? []).map((b64) => new Uint8Array(Buffer.from(b64, "base64")));
      if (images.length === 0) throw new Error("image generation returned no images");
      return { images, format: "png" };
    },
  };
}

let imageInvokerOverride: BedrockImageInvoker | null = null;
export function __setBedrockImageInvokerForTests(invoker: BedrockImageInvoker | null): void {
  imageInvokerOverride = invoker;
}
let defaultImageInvoker: BedrockImageInvoker | null = null;
export function getBedrockImageInvoker(): BedrockImageInvoker {
  if (imageInvokerOverride) return imageInvokerOverride;
  if (!defaultImageInvoker) defaultImageInvoker = makeImageInvoker();
  return defaultImageInvoker;
}

// ---------------------------------------------------------------------------
// Async generation (StartAsyncInvoke) — plan §3.8
// ---------------------------------------------------------------------------
//
// Generation models (video / large image) don't return their output inline; the
// caller supplies an S3 output URI and Bedrock writes the result there
// asynchronously under the INVOKING (capability) principal — the mirror of the
// S3-location input problem (plan §3.4). The broker therefore assumes the
// capability role under a session policy scoped to that single output prefix
// (see api-handler getCapabilityBrokerCreds). The job is then polled to
// completion via GetAsyncInvoke. This is kept a thin AWS wrapper behind the
// {@link BedrockAsyncInvoker} test seam; the provider-specific request body is
// built by the pure {@link buildAsyncModelInput}.

/** Normalized async status, collapsing the SDK's `AsyncInvokeStatus` strings. */
export type AsyncStatus = "InProgress" | "Completed" | "Failed";

/** Generation parameters the app requested, threaded to the provider body. Only
 * fields the CDS knows pre-call (so the reservation/cost math is CDS-derived). */
export interface AsyncGenerationParams {
  /** Requested video length in seconds — the CDS-derived cost basis (§3.8). */
  durationSeconds?: number;
  fps?: number;
  /** e.g. "1280x720". */
  dimension?: string;
  seed?: number;
}

export interface BedrockAsyncStartRequest {
  /** Model id to invoke (async foundation models take the bare id). */
  target: string;
  region: string;
  provider: ModelProvider;
  prompt: string;
  /** Optional reference image (inline or S3) for image-conditioned generation. */
  image?: BedrockImageInput;
  generation?: AsyncGenerationParams;
  /** s3:// URI (a per-invocation folder) Bedrock writes the output under. */
  outputS3Uri: string;
  /** Pin the output bucket to this account (confused-deputy guard). */
  outputBucketOwner?: string;
  credentials: BedrockInvokeRequest["credentials"];
}

export interface BedrockAsyncStartResult {
  invocationArn: string;
}

export interface BedrockAsyncStatusRequest {
  invocationArn: string;
  region: string;
  credentials: BedrockInvokeRequest["credentials"];
}

export interface BedrockAsyncStatusResult {
  status: AsyncStatus;
  failureMessage?: string;
  /** The output folder URI Bedrock reports (echoes what we supplied at start). */
  outputS3Uri?: string;
}

export interface BedrockAsyncInvoker {
  startAsync(req: BedrockAsyncStartRequest): Promise<BedrockAsyncStartResult>;
  getAsyncStatus(req: BedrockAsyncStatusRequest): Promise<BedrockAsyncStatusResult>;
}

/**
 * Build the provider-specific `modelInput` for an async generation request. Pure
 * and testable. Only the Amazon Nova (Reel) video shape is wired in this
 * increment (§3.8); any other provider throws until an adapter is added — with
 * NO IAM change (the boundary is all-Bedrock, §3.3).
 */
export function buildAsyncModelInput(req: BedrockAsyncStartRequest): Record<string, unknown> {
  if (req.provider !== "amazon") {
    throw new Error(`async generation not supported for provider "${req.provider}"`);
  }
  const g = req.generation ?? {};
  const textToVideoParams: Record<string, unknown> = { text: req.prompt };
  if (req.image) {
    // Nova Reel accepts a conditioning image inline (base64) only.
    if ("bytes" in req.image) {
      textToVideoParams.images = [
        {
          format: req.image.format,
          source: { bytes: Buffer.from(req.image.bytes).toString("base64") },
        },
      ];
    } else {
      textToVideoParams.images = [
        { format: req.image.format, source: { s3Location: { uri: req.image.s3Uri } } },
      ];
    }
  }
  return {
    taskType: "TEXT_VIDEO",
    textToVideoParams,
    videoGenerationConfig: {
      ...(g.durationSeconds !== undefined ? { durationSeconds: g.durationSeconds } : {}),
      ...(g.fps !== undefined ? { fps: g.fps } : {}),
      ...(g.dimension !== undefined ? { dimension: g.dimension } : {}),
      seed: g.seed ?? 0,
    },
  };
}

function normalizeAsyncStatus(status: string | undefined): AsyncStatus {
  // Unknown/absent → treat as in progress (never a spurious Completed/Failed).
  return status === "Completed" || status === "Failed" ? status : "InProgress";
}

export function makeAsyncInvoker(): BedrockAsyncInvoker {
  function clientFor(region: string, credentials: BedrockInvokeRequest["credentials"]) {
    return new BedrockRuntimeClient({ region, credentials });
  }
  return {
    async startAsync(req) {
      const client = clientFor(req.region, req.credentials);
      const out = await client.send(
        new StartAsyncInvokeCommand({
          modelId: req.target,
          modelInput: buildAsyncModelInput(req) as never,
          outputDataConfig: {
            s3OutputDataConfig: {
              s3Uri: req.outputS3Uri,
              ...(req.outputBucketOwner ? { bucketOwner: req.outputBucketOwner } : {}),
            },
          },
        }),
      );
      if (!out.invocationArn) throw new Error("StartAsyncInvoke returned no invocationArn");
      return { invocationArn: out.invocationArn };
    },

    async getAsyncStatus(req) {
      const client = clientFor(req.region, req.credentials);
      const out = await client.send(
        new GetAsyncInvokeCommand({ invocationArn: req.invocationArn }),
      );
      return {
        status: normalizeAsyncStatus(out.status),
        ...(out.failureMessage ? { failureMessage: out.failureMessage } : {}),
        ...(out.outputDataConfig?.s3OutputDataConfig?.s3Uri
          ? { outputS3Uri: out.outputDataConfig.s3OutputDataConfig.s3Uri }
          : {}),
      };
    },
  };
}

let asyncInvokerOverride: BedrockAsyncInvoker | null = null;
export function __setBedrockAsyncInvokerForTests(invoker: BedrockAsyncInvoker | null): void {
  asyncInvokerOverride = invoker;
}
let defaultAsyncInvoker: BedrockAsyncInvoker | null = null;
export function getBedrockAsyncInvoker(): BedrockAsyncInvoker {
  if (asyncInvokerOverride) return asyncInvokerOverride;
  if (!defaultAsyncInvoker) defaultAsyncInvoker = makeAsyncInvoker();
  return defaultAsyncInvoker;
}
