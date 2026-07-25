/**
 * Wire types shared by the capability model-registry API routes and the
 * operator editor UI (plan §3.6). The registry is two-layered — a read-only
 * PLATFORM registry shipped in `@starkeep/protocol-primitives` plus sparse
 * OPERATOR OVERRIDES in DSQL — and `effective = override ?? platformDefault`.
 *
 * PRICING crosses the wire in CANONICAL units — micros of currency per one
 * canonical quantity unit — exactly as it is stored and metered. There is no
 * display encoding on the wire and therefore nothing to round-trip: the
 * `toDisplayPrice`/`toStoredPrice` pair this module used to carry (and the
 * float-noise rounding it needed) is gone.
 *
 * Display conversion still exists, but only in the editor's rendering of a
 * field, and only via money.ts:
 *   - TOKEN keys need no conversion at all — `$3/MTok` IS `3 micros/token`, so
 *     the stored number is already the published figure (see
 *     `usdPerMTokToMicrosPerToken`);
 *   - other keys (per image, per millisecond) are shown as whole dollars per
 *     unit and parsed back with `usdDecimalPerUnitToMicrosPerUnit`, which is
 *     exact where a float multiply is not.
 */

import {
  ratePerUnitToUsdNumber,
  usdDecimalPerUnitToMicrosPerUnit,
  assertRate,
  type ModelProvider,
  type OutputModality,
  type MicrosPerUnit,
} from "@starkeep/protocol-primitives";

/** A model's resolved (or platform-default) values, in canonical units. */
export interface ModelRowValues {
  provider: string;
  /** Cross-region inference profile id, or null when none. */
  inferenceProfileId: string | null;
  vision: boolean;
  /** Output modality — decides the delivery channel (text = inline/streamed,
   * image = sync-S3, audio/video = async-S3). Intrinsic for a platform model. */
  outputModality: OutputModality;
  /** The whole price table in CANONICAL units (micros per unit), keyed
   * `"dimension:unit"`. Empty when the model has no pricing at all. */
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
   * Sparse price overrides in CANONICAL units (micros per unit), keyed
   * `"dimension:unit"`. Merged
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
// Price display units (canonical-units exception 2: rendering only)
// ---------------------------------------------------------------------------

/** The price keys whose canonical rate is numerically identical to the figure
 * providers publish, because `$x/MTok` === `x micros/token`. Shown as-is. */
export const PER_MTOK_PRICE_KEYS: readonly string[] = ["input:tokens", "output:tokens"];

export function isPerMTokPriceKey(key: string): boolean {
  return PER_MTOK_PRICE_KEYS.includes(key);
}

/**
 * The canonical rate as the number to put in an editor field.
 *
 * Token rates pass through untouched (the identity above). Other rates are shown
 * as whole dollars per unit, which is how a provider quotes them and how an
 * operator thinks about them — 40000 micros/image reads as 0.04.
 */
export function rateToFieldValue(key: string, rate: number): number {
  return isPerMTokPriceKey(key) ? rate : ratePerUnitToUsdNumber(rate as MicrosPerUnit);
}

/**
 * An editor field's text back to a canonical rate.
 *
 * Token rates are taken as-is (a fractional rate is expected and allowed — see
 * money.ts on why a rate is the one non-integer). Other rates go through the
 * exact decimal parser, never a float multiply.
 */
export function fieldValueToRate(key: string, text: string): MicrosPerUnit {
  const trimmed = text.trim();
  // Number("") is 0, so an empty field would otherwise silently price at zero.
  if (trimmed === "") throw new RangeError(`rate for ${key} is empty`);
  return isPerMTokPriceKey(key)
    ? assertRate(Number(trimmed), `rate for ${key}`)
    : usdDecimalPerUnitToMicrosPerUnit(trimmed);
}

/** The unit suffix to render next to a price field for `key`. */
export function priceUnitLabel(key: string): string {
  return isPerMTokPriceKey(key) ? "$/MTok" : "$/unit";
}

/** The provider options the editor offers, typed against the platform union so a
 * drift there is a compile error. */
export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  "anthropic",
  "amazon",
  "openai",
  "qwen",
  "kimi",
  "glm",
];

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
  "pixels",
  "tiles",
  "duration_ms",
  "pixel_frames",
] as const;

/**
 * The `"dimension:unit"` keys a model may carry a price for — every metered pair
 * except `cost:usd_micros`, which IS the derived price and so can never be a rate.
 *
 * Restated as a plain literal rather than derived from `DIMENSION_UNIT_SPECS`
 * so the client editor doesn't pull the whole dimension catalogue into its
 * bundle; `capability-models-server` validates posted keys against the
 * platform's own `isKnownDimensionUnit`, and a unit test pins this list to
 * `DIMENSION_UNIT_SPECS` so it cannot drift.
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
