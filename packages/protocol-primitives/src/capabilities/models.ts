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

export type ModelProvider = "anthropic" | "openai" | "qwen" | "kimi" | "glm";

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
    inferenceProfileId: "us.anthropic.claude-haiku-4-5",
    vision: true,
    defaults: { pricing: tokenPricing(1, 5), estimates: { imageTokens: 1600 } },
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
