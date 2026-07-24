/**
 * Server-only projection between the `shared.capability_model_overrides` DSQL
 * row shape, the platform registry in `@starkeep/protocol-primitives`, and the
 * wire types the editor consumes. Token prices are stored per-token in the DB
 * and shipped as $/MTok. See plan §3.6.
 */

import {
  PLATFORM_MODEL_REGISTRY,
  perMTok,
  dimensionUnitKey,
  type OperatorModelOverride,
  type ModelProvider,
  type PlatformModelEntry,
} from "@starkeep/protocol-primitives";
import type {
  ModelRow,
  ModelRowValues,
  ModelOverrideInput,
} from "./capability-models";

const TOK_IN = dimensionUnitKey("input", "tokens");
const TOK_OUT = dimensionUnitKey("output", "tokens");
const PER_MTOK = 1_000_000;

/** Raw override row as selected from DSQL. */
export interface OverrideRow {
  model_id: string;
  provider: string | null;
  inference_profile_id: string | null;
  inference_profile_cleared: boolean | null;
  vision: boolean | null;
  pricing_json: string | null;
  estimates_json: string | null;
}

function parseObj(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** $/MTok, rounded to kill float noise from the per-token ↔ $/MTok round-trip
 * (sub-1e-6 $/MTok precision is far finer than any real Bedrock rate). */
function toPerMTok(perToken: number): number {
  return Math.round(perToken * PER_MTOK * 1e6) / 1e6;
}

function pricePerMTok(pricing: Readonly<Record<string, number>>, key: string): number | null {
  const v = pricing[key];
  return typeof v === "number" ? toPerMTok(v) : null;
}

/** A DSQL override row → the sparse override the platform-merge logic consumes. */
export function rowToOverride(row: OverrideRow): OperatorModelOverride {
  const o: OperatorModelOverride = { modelId: row.model_id };
  if (row.provider) o.provider = row.provider as ModelProvider;
  if (row.inference_profile_cleared) o.inferenceProfileId = null;
  else if (row.inference_profile_id) o.inferenceProfileId = row.inference_profile_id;
  if (row.vision !== null && row.vision !== undefined) o.vision = row.vision;
  const pricing = parseObj(row.pricing_json);
  if (Object.keys(pricing).length > 0) o.pricing = pricing as Record<string, number>;
  const estimates = parseObj(row.estimates_json);
  if (Object.keys(estimates).length > 0) o.estimates = estimates as { imageTokens?: number };
  return o;
}

/** A DSQL override row → the sparse wire override the editor pre-fills from. */
export function rowToOverrideInput(row: OverrideRow): ModelOverrideInput {
  const out: ModelOverrideInput = {};
  if (row.provider) out.provider = row.provider;
  if (row.inference_profile_cleared) out.inferenceProfileId = null;
  else if (row.inference_profile_id) out.inferenceProfileId = row.inference_profile_id;
  if (row.vision !== null && row.vision !== undefined) out.vision = row.vision;
  const pricing = parseObj(row.pricing_json);
  const inTok = pricing[TOK_IN];
  const outTok = pricing[TOK_OUT];
  if (typeof inTok === "number") out.inputPerMTok = toPerMTok(inTok);
  if (typeof outTok === "number") out.outputPerMTok = toPerMTok(outTok);
  const estimates = parseObj(row.estimates_json);
  if (typeof estimates.imageTokens === "number") out.imageTokens = estimates.imageTokens;
  return out;
}

function platformValues(p: PlatformModelEntry): ModelRowValues {
  return {
    provider: p.provider,
    inferenceProfileId: p.inferenceProfileId ?? null,
    vision: p.vision,
    inputPerMTok: pricePerMTok(p.defaults.pricing, TOK_IN),
    outputPerMTok: pricePerMTok(p.defaults.pricing, TOK_OUT),
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
    // same way the broker's effectiveModel() does, but expressed in $/MTok.
    const ov = overrides.find((o) => o.modelId === modelId);
    const pricing: Record<string, number> = { ...(platform?.defaults.pricing ?? {}) };
    if (ov?.pricing) for (const [k, v] of Object.entries(ov.pricing)) pricing[k] = v;
    let inferenceProfileId: string | null;
    if (ov && "inferenceProfileId" in ov) inferenceProfileId = ov.inferenceProfileId ?? null;
    else inferenceProfileId = platform?.inferenceProfileId ?? null;
    return {
      provider: ov?.provider ?? platform?.provider ?? "",
      inferenceProfileId,
      vision: ov?.vision ?? platform?.vision ?? false,
      inputPerMTok: pricePerMTok(pricing, TOK_IN),
      outputPerMTok: pricePerMTok(pricing, TOK_OUT),
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
 * NULL (inherit). Pricing is written as a per-token table under the token keys. */
export interface OverrideColumns {
  provider: string | null;
  inference_profile_id: string | null;
  inference_profile_cleared: boolean;
  vision: boolean | null;
  pricing_json: string | null;
  estimates_json: string | null;
}

export function overrideInputToColumns(input: ModelOverrideInput): OverrideColumns {
  let pricing_json: string | null = null;
  if (typeof input.inputPerMTok === "number" && typeof input.outputPerMTok === "number") {
    pricing_json = JSON.stringify({
      [TOK_IN]: perMTok(input.inputPerMTok),
      [TOK_OUT]: perMTok(input.outputPerMTok),
    });
  }
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
    pricing_json,
    estimates_json,
  };
}
