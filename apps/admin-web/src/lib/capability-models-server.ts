/**
 * Server-only projection between the `shared.capability_model_overrides` DSQL
 * row shape, the platform registry in `@starkeep/protocol-primitives`, and the
 * wire types the editor consumes. See plan §3.6.
 *
 * Pricing is carried as a WHOLE per-`"dimension:unit"` table rather than a pair
 * of token rates: the platform registry prices Nova Canvas on `requests:image`
 * and Nova Reel on `output:duration_ms`, and an editor that could only express
 * token rates both hid those prices and silently dropped them on save (it
 * rewrote `pricing_json` wholesale). The DB, the wire, and the metering path all
 * use the SAME canonical units: micros of currency per one canonical quantity
 * unit. Display units exist only inside the editor's form fields.
 */

import {
  PLATFORM_MODEL_REGISTRY,
  isKnownDimensionUnit,
  parsePricingTable,
  type MicrosPerUnit,
  type OperatorModelOverride,
  type ModelProvider,
  type OutputModality,
  type PlatformModelEntry,
} from "@starkeep/protocol-primitives";
import {
  type ModelRow,
  type ModelRowValues,
  type ModelOverrideInput,
} from "./capability-models";

/** Raw override row as selected from DSQL. */
export interface OverrideRow {
  model_id: string;
  provider: string | null;
  inference_profile_id: string | null;
  inference_profile_cleared: boolean | null;
  vision: boolean | null;
  /** Output modality of an operator-DEFINED model; NULL for override-only rows
   * and for definitions that default to `text` (see `effectiveModel`). */
  output_modality: string | null;
  pricing_json: string | null;
  estimates_json: string | null;
}

function parseObj(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The valid rate entries of a stored pricing blob, in canonical micros per unit.
 * Delegates to money.ts so this loader and the installer's cannot disagree about
 * what a stored blob means. */
function parsePricing(json: string | null): Record<string, MicrosPerUnit> {
  return parsePricingTable(json);
}

/** A DSQL override row → the sparse override the platform-merge logic consumes. */
export function rowToOverride(row: OverrideRow): OperatorModelOverride {
  const o: OperatorModelOverride = { modelId: row.model_id };
  if (row.provider) o.provider = row.provider as ModelProvider;
  if (row.inference_profile_cleared) o.inferenceProfileId = null;
  else if (row.inference_profile_id) o.inferenceProfileId = row.inference_profile_id;
  if (row.vision !== null && row.vision !== undefined) o.vision = row.vision;
  if (row.output_modality) o.outputModality = row.output_modality as OutputModality;
  const pricing = parsePricing(row.pricing_json);
  if (Object.keys(pricing).length > 0) o.pricing = pricing;
  const estimates = parseObj(row.estimates_json);
  if (typeof estimates.imageTokens === "number") o.estimates = { imageTokens: estimates.imageTokens };
  return o;
}

/** A DSQL override row → the sparse wire override the editor pre-fills from. */
export function rowToOverrideInput(row: OverrideRow): ModelOverrideInput {
  const out: ModelOverrideInput = {};
  if (row.provider) out.provider = row.provider;
  if (row.inference_profile_cleared) out.inferenceProfileId = null;
  else if (row.inference_profile_id) out.inferenceProfileId = row.inference_profile_id;
  if (row.vision !== null && row.vision !== undefined) out.vision = row.vision;
  if (row.output_modality) out.outputModality = row.output_modality as OutputModality;
  const pricing = parsePricing(row.pricing_json);
  if (Object.keys(pricing).length > 0) out.pricing = pricing;
  const estimates = parseObj(row.estimates_json);
  if (typeof estimates.imageTokens === "number") out.imageTokens = estimates.imageTokens;
  return out;
}

function platformValues(p: PlatformModelEntry): ModelRowValues {
  return {
    provider: p.provider,
    inferenceProfileId: p.inferenceProfileId ?? null,
    vision: p.vision,
    outputModality: p.outputModality ?? "text",
    pricing: { ...p.defaults.pricing },
    imageTokens: p.defaults.estimates.imageTokens ?? null,
  };
}

/**
 * Merge the platform registry with the operator override rows into the editor's
 * per-model rows. Every platform model appears; operator-DEFINED models (a row
 * whose model_id has no platform entry) are appended.
 */
export function buildModelRows(rows: OverrideRow[]): ModelRow[] {
  const overrides = rows.map(rowToOverride);
  const overrideByIdWire = new Map(rows.map((r) => [r.model_id, rowToOverrideInput(r)]));
  const platformIds = new Set(PLATFORM_MODEL_REGISTRY.map((m) => m.modelId));

  const effectiveOf = (modelId: string, platform: PlatformModelEntry | null): ModelRowValues => {
    // Re-derive the merged view field-by-field so pricing/estimates merge the
    // same way the broker's effectiveModel() does. No unit change: canonical throughout.
    const ov = overrides.find((o) => o.modelId === modelId);
    const pricing: Record<string, MicrosPerUnit> = { ...(platform?.defaults.pricing ?? {}) };
    if (ov?.pricing) for (const [k, v] of Object.entries(ov.pricing)) pricing[k] = v;
    let inferenceProfileId: string | null;
    if (ov && "inferenceProfileId" in ov) inferenceProfileId = ov.inferenceProfileId ?? null;
    else inferenceProfileId = platform?.inferenceProfileId ?? null;
    return {
      provider: ov?.provider ?? platform?.provider ?? "",
      inferenceProfileId,
      vision: ov?.vision ?? platform?.vision ?? false,
      // Mirrors effectiveModel(): a platform model's modality is intrinsic and
      // always wins; an override's modality only defines an operator model.
      outputModality: platform
        ? (platform.outputModality ?? "text")
        : (ov?.outputModality ?? "text"),
      pricing,
      imageTokens: (ov?.estimates?.imageTokens ?? platform?.defaults.estimates.imageTokens) ?? null,
    };
  };

  const rowsOut: ModelRow[] = PLATFORM_MODEL_REGISTRY.map((p) => ({
    modelId: p.modelId,
    source: "platform" as const,
    effective: effectiveOf(p.modelId, p),
    platform: platformValues(p),
    override: overrideByIdWire.get(p.modelId) ?? {},
  }));

  for (const r of rows) {
    if (platformIds.has(r.model_id)) continue;
    rowsOut.push({
      modelId: r.model_id,
      source: "user",
      effective: effectiveOf(r.model_id, null),
      platform: null,
      override: overrideByIdWire.get(r.model_id) ?? {},
    });
  }
  return rowsOut;
}

/** The columns to persist for a save. A field absent from `input` is stored as
 * NULL (inherit). Pricing is written as a per-unit table keyed
 * `"dimension:unit"`. */
export interface OverrideColumns {
  provider: string | null;
  inference_profile_id: string | null;
  inference_profile_cleared: boolean;
  vision: boolean | null;
  output_modality: string | null;
  pricing_json: string | null;
  estimates_json: string | null;
}

export function overrideInputToColumns(input: ModelOverrideInput): OverrideColumns {
  // Already canonical (micros per unit) — the route validated it and the client
  // converted any display field through money.ts. Nothing to convert here, which
  // is the point: there is exactly one representation from the form to the row.
  const canonicalPricing: Record<string, MicrosPerUnit> = {};
  for (const [k, v] of Object.entries(input.pricing ?? {})) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) canonicalPricing[k] = v as MicrosPerUnit;
  }
  const pricing_json =
    Object.keys(canonicalPricing).length > 0 ? JSON.stringify(canonicalPricing) : null;

  const estimates_json =
    typeof input.imageTokens === "number"
      ? JSON.stringify({ imageTokens: input.imageTokens })
      : null;

  // inferenceProfileId: null in the input = explicitly cleared; a string = set;
  // absent key = inherit (both columns null / cleared false).
  const hasProfileKey = Object.prototype.hasOwnProperty.call(input, "inferenceProfileId");
  const cleared = hasProfileKey && input.inferenceProfileId === null;
  const profileId =
    hasProfileKey && typeof input.inferenceProfileId === "string" ? input.inferenceProfileId : null;

  return {
    provider: input.provider ?? null,
    inference_profile_id: profileId,
    inference_profile_cleared: cleared,
    vision: typeof input.vision === "boolean" ? input.vision : null,
    output_modality: input.outputModality ?? null,
    pricing_json,
    estimates_json,
  };
}

/** True when the override carries nothing at all — equivalent to no override,
 * so a platform model takes the DELETE branch rather than persisting an
 * all-NULL row. */
export function isEmptyOverride(cols: OverrideColumns): boolean {
  return (
    cols.provider === null &&
    cols.inference_profile_id === null &&
    cols.inference_profile_cleared === false &&
    cols.vision === null &&
    cols.output_modality === null &&
    cols.pricing_json === null &&
    cols.estimates_json === null
  );
}

/**
 * Validate a posted pricing table. Every key must be a `(dimension, unit)` the
 * platform meters — a price on an unknown key would never be applied by
 * `deriveCostMicros`, so it would silently read as "priced" while contributing
 * nothing to the cost gate. The two token rates must be set together for the
 * same reason the pair was always enforced: a model priced on input tokens but
 * not output under-counts every call.
 */
export function validatePricing(pricing: Record<string, unknown> | undefined): string | null {
  if (pricing === undefined) return null;
  if (typeof pricing !== "object" || pricing === null || Array.isArray(pricing)) {
    return "pricing must be an object keyed by \"dimension:unit\"";
  }
  for (const [key, value] of Object.entries(pricing)) {
    const [dimension, unit] = key.split(":");
    if (!dimension || !unit || !isKnownDimensionUnit(dimension, unit)) {
      return `pricing key "${key}" is not a metered (dimension, unit) pair`;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `pricing for "${key}" must be a non-negative number`;
    }
  }
  const hasIn = "input:tokens" in pricing;
  const hasOut = "output:tokens" in pricing;
  if (hasIn !== hasOut) return "input and output $/MTok must be set together";
  return null;
}
