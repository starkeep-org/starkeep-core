/**
 * The Bedrock model registry (see plan §3.6), as **two layered tables**:
 *
 *   - PLATFORM REGISTRY — shipped with the code, read-only, versioned. Seeds
 *     provider, inference profile, per-dimension pricing, and estimation
 *     defaults for the models the platform knows.
 *   - OPERATOR OVERRIDES — a sparse, operator-set table keyed by `(modelId,
 *     field)`. Lets an operator adopt a new AWS model, or retune pricing, on
 *     AWS's cadence rather than waiting for a platform release.
 *
 * The effective value of any field is `override ?? platformDefault`, so there is
 * no flag-flip state machine and no migration when the platform later ships a
 * model the operator had defined: the platform default simply begins to exist
 * and `effective()` picks it up for any field the operator didn't override. The
 * "source" (`platform` vs `user`) is DERIVED ("is there a platform row?"), never
 * stored.
 *
 * Pricing drives the derived `cost` gate and the ledger; Bedrock never returns a
 * dollar figure (§3.5), so cost is always estimated from usage × these rates.
 */

import { dimensionUnitKey } from "./dimensions.js";

export type ModelProvider = "anthropic" | "openai" | "qwen" | "kimi" | "glm" | "amazon";

/**
 * What kind of output a model produces. This single fact determines the delivery
 * channel (plan §3.8):
 *   - `text`  → delivered INLINE (sync `/invoke`) or STREAMED (`/invoke-stream`),
 *     the app's per-request choice of endpoint;
 *   - `image` | `audio` | `video` → always written to S3 and produced
 *     ASYNCHRONOUSLY (`/invoke-async` + poll). There is no inline path for
 *     non-text output.
 * So "async S3 output" is DERIVED from the modality (see {@link outputIsAsyncS3}),
 * not a separate model flag.
 */
export type OutputModality = "text" | "image" | "audio" | "video";

/** Per-`(dimension:unit)` price, in USD per single unit. Token rates are stored
 * here already divided down from the conventional $/MTok (see {@link perMTok}). */
export type PricingTable = Readonly<Record<string, number>>;

export interface ModelEstimates {
  /** Tokens to charge per input image before Bedrock returns the exact count —
   * used only to RESERVE against token/cost gates pre-call; reconciled to the
   * exact returned count post-call. */
  imageTokens?: number;
}

export interface ModelDefaults {
  pricing: PricingTable;
  estimates: ModelEstimates;
}

export interface PlatformModelEntry {
  modelId: string;
  provider: ModelProvider;
  /** Cross-region inference profile id (region-prefixed, e.g.
   * `us.anthropic.claude-sonnet-5`) when the model requires one for on-demand
   * throughput; absent for models invocable directly as a foundation model. */
  inferenceProfileId?: string;
  /** Whether the model accepts image input (needed for the captioning case). */
  vision: boolean;
  /** The model's output modality (plan §3.8). Defaults to `text` when omitted.
   * Non-text modalities are delivered as async S3 output; text is inline/streamed.
   * The delivery channel is DERIVED from this — see {@link outputIsAsyncS3}. */
  outputModality?: OutputModality;
  defaults: ModelDefaults;
}

/** A sparse operator override. Any present field wins over the platform default;
 * absent fields fall through. `provider`/`vision` may be set for an
 * operator-DEFINED model the platform doesn't yet know. */
export interface OperatorModelOverride {
  modelId: string;
  provider?: ModelProvider;
  inferenceProfileId?: string | null;
  vision?: boolean;
  /** Output modality for an operator-DEFINED model (a modelId the platform
   * registry doesn't contain) — this is part of "add a custom model", NOT an
   * override of a platform model. A platform model's modality is intrinsic and
   * always wins; this field is ignored when a platform row exists (see
   * {@link effectiveModel}). */
  outputModality?: OutputModality;
  /** Per-`(dimension:unit)` USD/unit overrides, merged over the platform table. */
  pricing?: Readonly<Record<string, number>>;
  estimates?: ModelEstimates;
}

/** Convert a conventional $/million-token rate to USD per single token. */
export function perMTok(usdPerMillion: number): number {
  return usdPerMillion / 1_000_000;
}

const TOK_IN = dimensionUnitKey("input", "tokens");
const TOK_OUT = dimensionUnitKey("output", "tokens");

function tokenPricing(inPerMTok: number, outPerMTok: number): PricingTable {
  return { [TOK_IN]: perMTok(inPerMTok), [TOK_OUT]: perMTok(outPerMTok) };
}

/**
 * The shipped platform registry. Exact Bedrock model ids for the non-Anthropic
 * providers are confirm-at-implementation (§3.6 / open question 12); the ids and
 * inference profiles below reflect the plan's documented set and are overridable
 * by the operator without a platform release.
 *
 * Pricing is the first-party per-MTok reference from the plan (§3.6); confirm
 * Bedrock's published region-specific rates before relying on the derived cost
 * gate as a hard dollar cap.
 */
export const PLATFORM_MODEL_REGISTRY: readonly PlatformModelEntry[] = [
  {
    modelId: "anthropic.claude-haiku-4-5",
    provider: "anthropic",
    // Unversioned aliases exist for sonnet-5/opus-4-8, but NOT for haiku-4-5 —
    // its only on-demand cross-region profile is the dated id (confirmed live in
    // us-east-2/us-east-1 via bedrock list-inference-profiles).
    inferenceProfileId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    vision: true,
    defaults: { pricing: tokenPricing(1, 5), estimates: { imageTokens: 1600 } },
  },
  {
    // Amazon Nova Lite — vision-capable, on the Converse path, and (being
    // Amazon's own model) reachable WITHOUT the Anthropic use-case-form gate,
    // so it is the form-free vision option for captioning. On-demand via the
    // cross-region inference profile. Pricing per Bedrock: ~$0.06/$0.24 per MTok.
    modelId: "amazon.nova-lite",
    provider: "amazon",
    inferenceProfileId: "us.amazon.nova-lite-v1:0",
    vision: true,
    defaults: { pricing: tokenPricing(0.06, 0.24), estimates: { imageTokens: 1300 } },
  },
  {
    modelId: "anthropic.claude-sonnet-5",
    provider: "anthropic",
    inferenceProfileId: "us.anthropic.claude-sonnet-5",
    vision: true,
    // $2 / $10 introductory through 2026-08-31; standard $3 / $15. Seed standard
    // and let the operator override for the intro window.
    defaults: { pricing: tokenPricing(3, 15), estimates: { imageTokens: 1600 } },
  },
  {
    modelId: "anthropic.claude-opus-4-8",
    provider: "anthropic",
    inferenceProfileId: "us.anthropic.claude-opus-4-8",
    vision: true,
    defaults: { pricing: tokenPricing(5, 25), estimates: { imageTokens: 1600 } },
  },
  {
    modelId: "openai.gpt-oss-120b",
    provider: "openai",
    vision: false,
    // Confirm current Bedrock per-MTok rates at implementation.
    defaults: { pricing: tokenPricing(0.15, 0.6), estimates: {} },
  },
  {
    modelId: "qwen.qwen3-235b",
    provider: "qwen",
    vision: false,
    defaults: { pricing: tokenPricing(0.2, 0.85), estimates: {} },
  },
  // Kimi (Moonshot) and GLM (Zhipu): availability, invoke route, and exact ids
  // are confirm-at-implementation (open question 12). Seeded so the multi-
  // provider registry shape is exercised; operator overrides supply real ids.
  {
    modelId: "kimi.k2",
    provider: "kimi",
    vision: false,
    defaults: { pricing: tokenPricing(0.6, 2.5), estimates: {} },
  },
  {
    modelId: "glm.glm-4.6",
    provider: "glm",
    vision: false,
    defaults: { pricing: tokenPricing(0.6, 2.2), estimates: {} },
  },
  {
    // Amazon Nova Reel — video generation. Its `video` output modality means the
    // output is written asynchronously to S3 by StartAsyncInvoke (plan §3.8) —
    // the async start/poll flow, NOT the synchronous Converse path. Billed per
    // second of generated video, which the CDS controls via the request's
    // requested duration — so cost is CDS-derived (priced on output:duration_s)
    // and the load-bearing cost gate holds without any app self-report. Exact
    // model id and per-second rate are confirm-at-implementation (open question
    // 12); seeded so the async path is exercised and overridable by the operator.
    modelId: "amazon.nova-reel",
    provider: "amazon",
    vision: false,
    outputModality: "video",
    defaults: {
      pricing: { [dimensionUnitKey("output", "duration_s")]: 0.08 },
      estimates: {},
    },
  },
];

const PLATFORM_BY_ID = new Map<string, PlatformModelEntry>(
  PLATFORM_MODEL_REGISTRY.map((m) => [m.modelId, m]),
);

/**
 * A resolved model: `override ?? platformDefault`, per field. `source` is derived
 * from whether a platform row exists. `pricing` is the platform table with the
 * override's per-`(dimension:unit)` entries merged on top.
 */
export interface EffectiveModel {
  modelId: string;
  provider: ModelProvider;
  inferenceProfileId?: string;
  vision: boolean;
  /** Resolved output modality (plan §3.8). Drives metering + the delivery channel
   * (text = inline/streamed; image/audio/video = async S3 — see
   * {@link outputIsAsyncS3}). */
  outputModality: OutputModality;
  pricing: PricingTable;
  estimates: ModelEstimates;
  source: "platform" | "user";
}

/**
 * Resolve a model against the platform registry and the operator overrides.
 *
 * Returns undefined only when the model is neither platform-known nor
 * operator-defined (an unknown model — install grant validation and the broker
 * both reject it). An operator-defined model (override with no platform row)
 * must carry enough to gate/meter — at minimum a provider; callers that need
 * pricing to enforce a cost gate check for its presence separately.
 */
export function effectiveModel(
  modelId: string,
  overrides: readonly OperatorModelOverride[] = [],
): EffectiveModel | undefined {
  const platform = PLATFORM_BY_ID.get(modelId);
  const override = overrides.find((o) => o.modelId === modelId);
  if (!platform && !override) return undefined;

  const provider = override?.provider ?? platform?.provider;
  if (!provider) {
    // Operator-defined model missing a provider is not gate/meter-able.
    return undefined;
  }

  const pricing: Record<string, number> = { ...(platform?.defaults.pricing ?? {}) };
  if (override?.pricing) {
    for (const [k, v] of Object.entries(override.pricing)) pricing[k] = v;
  }

  const estimates: ModelEstimates = {
    ...(platform?.defaults.estimates ?? {}),
    ...(override?.estimates ?? {}),
  };

  // inferenceProfileId: an override may explicitly clear it with null.
  let inferenceProfileId: string | undefined;
  if (override && "inferenceProfileId" in override) {
    inferenceProfileId = override.inferenceProfileId ?? undefined;
  } else {
    inferenceProfileId = platform?.inferenceProfileId;
  }

  return {
    modelId,
    provider,
    ...(inferenceProfileId ? { inferenceProfileId } : {}),
    vision: override?.vision ?? platform?.vision ?? false,
    // outputModality is DEFINITIONAL, not an override: a platform model's output
    // modality is intrinsic (you never re-purpose Haiku as a video model), so the
    // platform value always wins when a platform row exists. An override's
    // outputModality is honored ONLY for an operator-DEFINED model (no platform
    // row) — it is part of "add a custom model", never "override a platform
    // model". A model that genuinely supports multiple output modalities is
    // represented as SEPARATE platform entries (multi-purpose), not one entry an
    // override re-points.
    outputModality: platform ? (platform.outputModality ?? "text") : (override?.outputModality ?? "text"),
    pricing,
    estimates,
    source: platform ? "platform" : "user",
  };
}

/** True if `modelId` resolves against platform ∪ operator overrides. Used by
 * install-time validation of a manifest's `models[]` against the EFFECTIVE
 * registry (§3.1). */
export function isModelInEffectiveRegistry(
  modelId: string,
  overrides: readonly OperatorModelOverride[] = [],
): boolean {
  return effectiveModel(modelId, overrides) !== undefined;
}

/** The Bedrock target id to invoke: the inference profile when present (required
 * for on-demand throughput on newer models), else the bare model id. */
export function bedrockInvokeTarget(model: EffectiveModel): string {
  return model.inferenceProfileId ?? model.modelId;
}

/**
 * Whether a model's output is delivered as ASYNC S3 output (plan §3.8), derived
 * solely from its output modality: non-text (image/audio/video) is always written
 * to S3 by StartAsyncInvoke; text is inline (sync) or streamed. This single
 * predicate is the routing rule — text ⇒ `/invoke`(+stream), non-text ⇒
 * `/invoke-async`.
 */
export function outputIsAsyncS3(modality: OutputModality): boolean {
  return modality !== "text";
}
