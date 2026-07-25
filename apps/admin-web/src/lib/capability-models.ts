/**
 * Wire types shared by the capability model-registry API routes and the
 * operator editor UI (plan §3.6). The registry is two-layered — a read-only
 * PLATFORM registry shipped in `@starkeep/protocol-primitives` plus sparse
 * OPERATOR OVERRIDES in DSQL — and `effective = override ?? platformDefault`.
 *
 * PRICING crosses the wire as a full per-`"dimension:unit"` table in DISPLAY
 * units, because Bedrock does not bill every model on tokens: Nova Canvas is
 * priced per `requests:image` and Nova Reel per `output:duration_s`. The only
 * display convention is that the two TOKEN keys are shown per-million-tokens
 * (the universal published convention) while every other key is plain USD per
 * unit; the DB always stores USD per single unit. See {@link toDisplayPrice}.
 *
 * Type-only imports from protocol-primitives keep this module client-safe (it
 * is imported by the editor component); the runtime option lists below are
 * typed against the platform unions so a drift there is a compile error.
 */

import type { ModelProvider, OutputModality } from "@starkeep/protocol-primitives";

/** A model's resolved (or platform-default) values, in display units. */
export interface ModelRowValues {
  provider: string;
  /** Cross-region inference profile id, or null when none. */
  inferenceProfileId: string | null;
  vision: boolean;
  /** Output modality — decides the delivery channel (text = inline/streamed,
   * image = sync-S3, audio/video = async-S3). Intrinsic for a platform model. */
  outputModality: OutputModality;
  /** The whole price table in DISPLAY units, keyed `"dimension:unit"`. Empty
   * when the model has no pricing at all. */
  pricing: Record<string, number>;
  /** Per-image token estimate used to reserve against gates pre-call. */
  imageTokens: number | null;
}

/** The operator's sparse override for one model. A present key means "override
 * this field"; an absent key means "inherit the platform default". */
export interface ModelOverrideInput {
  provider?: string;
  /** string = set profile; null = explicitly cleared (no profile); absent = inherit. */
  inferenceProfileId?: string | null;
  vision?: boolean;
  /**
   * Output modality of an operator-DEFINED model. This is part of "add a custom
   * model", NOT an override — a platform model's modality is intrinsic, so the
   * write route rejects this field for a platform id rather than storing a value
   * the broker would ignore.
   */
  outputModality?: OutputModality;
  /**
   * Sparse price overrides in DISPLAY units, keyed `"dimension:unit"`. Merged
   * over the platform table key-by-key, so a model may be repriced on
   * `requests:image` without touching its token rates. The two token keys must
   * be set together (a model priced on input tokens but not output would
   * under-count spend); the write route enforces that.
   */
  pricing?: Record<string, number>;
  imageTokens?: number;
}

export interface ModelRow {
  modelId: string;
  /** "platform" = the platform registry knows this model; "user" = defined
   * solely by an operator override (no platform row). */
  source: "platform" | "user";
  /** Merged values shown in the table. */
  effective: ModelRowValues;
  /** Platform defaults (for showing the inherited value of un-overridden
   * fields in the editor); null for an operator-defined model. */
  platform: ModelRowValues | null;
  /** The raw sparse override, so the editor knows which fields are overridden. */
  override: ModelOverrideInput;
}

export interface ModelRegistryResponse {
  models: ModelRow[];
}

// ---------------------------------------------------------------------------
// Price display units
// ---------------------------------------------------------------------------

export const PER_MTOK = 1_000_000;

/** The price keys shown per MILLION units rather than per unit. Only the two
 * token rates use that convention; per-image / per-second rates are quoted
 * per unit by every provider. */
export const PER_MTOK_PRICE_KEYS: readonly string[] = ["input:tokens", "output:tokens"];

export function isPerMTokPriceKey(key: string): boolean {
  return PER_MTOK_PRICE_KEYS.includes(key);
}

/** Stored USD-per-unit → the display number. Token rates are rounded to kill
 * float noise from the per-token ↔ $/MTok round-trip (sub-1e-6 $/MTok precision
 * is far finer than any real Bedrock rate). */
export function toDisplayPrice(key: string, usdPerUnit: number): number {
  if (!isPerMTokPriceKey(key)) return usdPerUnit;
  return Math.round(usdPerUnit * PER_MTOK * 1e6) / 1e6;
}

/** Display number → the USD-per-unit value the DB stores. */
export function toStoredPrice(key: string, display: number): number {
  return isPerMTokPriceKey(key) ? display / PER_MTOK : display;
}

/** The unit suffix to render next to a price for `key`. */
export function priceUnitLabel(key: string): string {
  return isPerMTokPriceKey(key) ? "$/MTok" : "$/unit";
}

/** Convert a whole stored table to display units (and back). */
export function toDisplayPricing(stored: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(stored)) {
    if (typeof v === "number") out[k] = toDisplayPrice(k, v);
  }
  return out;
}

export function toStoredPricing(display: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(display)) out[k] = toStoredPrice(k, v);
  return out;
}

// ---------------------------------------------------------------------------
// Option lists for the editor's dropdowns
// ---------------------------------------------------------------------------

/** Provider ids the platform registry recognizes (for the new-model dropdown).
 * Typed against `ModelProvider` so adding a provider upstream without updating
 * this list fails to compile. */
export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  "anthropic",
  "amazon",
  "openai",
  "qwen",
  "kimi",
  "glm",
];
export type ModelProviderId = ModelProvider;

/** Output modalities an operator-defined model may declare. */
export const MODEL_OUTPUT_MODALITIES: readonly OutputModality[] = [
  "text",
  "image",
  "audio",
  "video",
];

/** The `input`/`output` units, which share one set. */
const IO_UNITS = [
  "bytes",
  "tokens",
  "characters",
  "pages",
  "frames",
  "megapixels",
  "tiles",
  "duration_s",
  "megapixel_seconds",
] as const;

/**
 * The `"dimension:unit"` keys a model may carry a price for — every metered pair
 * except `cost:usd`, which IS the derived price and so can never be a rate.
 *
 * Restated here rather than imported so this module stays free of runtime
 * imports (it is bundled into the client editor); `capability-models-server`
 * validates posted keys against the platform's own `isKnownDimensionUnit`, and
 * a unit test pins this list to `DIMENSION_UNIT_SPECS` so it cannot drift.
 */
export const PRICEABLE_DIMENSION_UNITS: readonly string[] = [
  "requests:all",
  "requests:text",
  "requests:image",
  "requests:audio",
  "requests:video",
  ...IO_UNITS.map((u) => `input:${u}`),
  ...IO_UNITS.map((u) => `output:${u}`),
  "credits:count",
];
