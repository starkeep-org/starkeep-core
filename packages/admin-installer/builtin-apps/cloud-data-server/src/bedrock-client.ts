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
  type ContentBlock,
  type ImageFormat,
} from "@aws-sdk/client-bedrock-runtime";
import type { ModelProvider } from "@starkeep/protocol-primitives";

export interface BedrockImageInput {
  format: ImageFormat; // "png" | "jpeg" | "gif" | "webp"
  bytes: Uint8Array;
}

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
    content.push({ image: { format: img.format, source: { bytes: img.bytes } } });
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
