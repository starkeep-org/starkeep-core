/**
 * The DSQL-row ↔ wire projection behind the operator model registry (plan §3.6).
 *
 * The load-bearing property here is that the editor can express EVERY price the
 * platform registry ships — not just token rates. Bedrock prices Nova Canvas per
 * `requests:image` and Nova Reel per `output:duration_s`; when this projection
 * only understood `input:tokens`/`output:tokens` those models showed no price at
 * all and any save through the editor rewrote `pricing_json` wholesale, silently
 * deleting the rate the cost gate is derived from.
 */
import { describe, it, expect } from "vitest";
import {
  PLATFORM_MODEL_REGISTRY,
  DIMENSION_UNIT_SPECS,
  dimensionUnitKey,
} from "@starkeep/protocol-primitives";
import {
  buildModelRows,
  overrideInputToColumns,
  rowToOverride,
  rowToOverrideInput,
  isEmptyOverride,
  validatePricing,
  type OverrideRow,
} from "../src/lib/capability-models-server";
import {
  PRICEABLE_DIMENSION_UNITS,
  toDisplayPrice,
  toStoredPrice,
  priceUnitLabel,
  type ModelOverrideInput,
} from "../src/lib/capability-models";

/** A DSQL row with all-null override columns unless overridden. */
function row(over: Partial<OverrideRow> & { model_id: string }): OverrideRow {
  return {
    provider: null,
    inference_profile_id: null,
    inference_profile_cleared: null,
    vision: null,
    output_modality: null,
    pricing_json: null,
    estimates_json: null,
    ...over,
  };
}

const HAIKU = "anthropic.claude-haiku-4-5";
const CANVAS = "amazon.nova-canvas-v1:0";
const REEL = "amazon.nova-reel-v1:1";
const TOK_IN = "input:tokens";
const TOK_OUT = "output:tokens";
const REQ_IMAGE = "requests:image";
const DURATION = "output:duration_s";

const find = (rows: ReturnType<typeof buildModelRows>, id: string) =>
  rows.find((r) => r.modelId === id)!;

// ---------------------------------------------------------------------------
// Display units
// ---------------------------------------------------------------------------

describe("price display units", () => {
  it("shows only the TOKEN rates per million; every other rate is per unit", () => {
    expect(toDisplayPrice(TOK_IN, 3 / 1e6)).toBe(3);
    expect(toDisplayPrice(TOK_OUT, 15 / 1e6)).toBe(15);
    // A per-image or per-second rate is already quoted per unit — scaling it by
    // a million would show $40,000 per image.
    expect(toDisplayPrice(REQ_IMAGE, 0.04)).toBe(0.04);
    expect(toDisplayPrice(DURATION, 0.08)).toBe(0.08);
  });

  it("round-trips display ↔ stored for both conventions", () => {
    for (const [key, display] of [[TOK_IN, 3], [REQ_IMAGE, 0.04], [DURATION, 0.08]] as const) {
      expect(toDisplayPrice(key, toStoredPrice(key, display))).toBe(display);
    }
  });

  it("labels the unit so the operator knows which convention a field uses", () => {
    expect(priceUnitLabel(TOK_IN)).toBe("$/MTok");
    expect(priceUnitLabel(REQ_IMAGE)).toBe("$/unit");
  });

  it("kills float noise from the per-token round-trip", () => {
    // 0.06 / 1e6 * 1e6 is 0.06000000000000001 without the rounding.
    expect(toDisplayPrice(TOK_IN, 0.06 / 1e6)).toBe(0.06);
  });
});

describe("PRICEABLE_DIMENSION_UNITS", () => {
  it("is exactly the platform's metered pairs minus cost:usd (which IS the price)", () => {
    const expected = DIMENSION_UNIT_SPECS.map((s) => dimensionUnitKey(s.dimension, s.unit)).filter(
      (k) => k !== "cost:usd",
    );
    expect([...PRICEABLE_DIMENSION_UNITS].sort()).toEqual([...expected].sort());
  });

  it("covers every key the shipped platform registry actually prices", () => {
    for (const m of PLATFORM_MODEL_REGISTRY) {
      for (const key of Object.keys(m.defaults.pricing)) {
        expect(PRICEABLE_DIMENSION_UNITS, `${m.modelId} ${key}`).toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// buildModelRows
// ---------------------------------------------------------------------------

describe("buildModelRows (no overrides)", () => {
  const rows = buildModelRows([]);

  it("returns every platform model, all source=platform with empty overrides", () => {
    expect(rows).toHaveLength(PLATFORM_MODEL_REGISTRY.length);
    expect(rows.every((r) => r.source === "platform")).toBe(true);
    expect(rows.every((r) => Object.keys(r.override).length === 0)).toBe(true);
  });

  it("exposes token pricing in $/MTok (haiku $1 in / $5 out)", () => {
    const haiku = find(rows, HAIKU);
    expect(haiku.effective.pricing).toEqual({ [TOK_IN]: 1, [TOK_OUT]: 5 });
    expect(haiku.effective.vision).toBe(true);
    expect(haiku.platform).toEqual(haiku.effective);
  });

  it("exposes the NON-token rates the editor used to hide entirely", () => {
    expect(find(rows, CANVAS).effective.pricing).toEqual({ [REQ_IMAGE]: 0.04 });
    expect(find(rows, REEL).effective.pricing).toEqual({ [DURATION]: 0.08 });
  });

  it("carries each model's output modality (it decides the delivery channel)", () => {
    expect(find(rows, HAIKU).effective.outputModality).toBe("text");
    expect(find(rows, CANVAS).effective.outputModality).toBe("image");
    expect(find(rows, REEL).effective.outputModality).toBe("video");
  });

  it("never leaves a model without a modality (omitted = text)", () => {
    expect(rows.every((r) => r.effective.outputModality.length > 0)).toBe(true);
  });
});

describe("buildModelRows (with overrides)", () => {
  it("merges a token-pricing override into effective, keeps source=platform", () => {
    const rows = buildModelRows([
      row({ model_id: HAIKU, pricing_json: JSON.stringify({ [TOK_IN]: 2 / 1e6, [TOK_OUT]: 8 / 1e6 }) }),
    ]);
    const haiku = find(rows, HAIKU);
    expect(haiku.effective.pricing).toEqual({ [TOK_IN]: 2, [TOK_OUT]: 8 });
    expect(haiku.source).toBe("platform");
    // Un-overridden platform default is still exposed for the editor.
    expect(haiku.platform!.pricing[TOK_IN]).toBe(1);
    expect(haiku.override.pricing).toEqual({ [TOK_IN]: 2, [TOK_OUT]: 8 });
  });

  it("merges a PER-IMAGE rate — the case the token-only editor couldn't reach", () => {
    const rows = buildModelRows([
      row({ model_id: CANVAS, pricing_json: JSON.stringify({ [REQ_IMAGE]: 0.06 }) }),
    ]);
    expect(find(rows, CANVAS).effective.pricing).toEqual({ [REQ_IMAGE]: 0.06 });
    expect(find(rows, CANVAS).override.pricing).toEqual({ [REQ_IMAGE]: 0.06 });
  });

  it("merges a PER-SECOND video rate", () => {
    const rows = buildModelRows([
      row({ model_id: REEL, pricing_json: JSON.stringify({ [DURATION]: 0.12 }) }),
    ]);
    expect(find(rows, REEL).effective.pricing).toEqual({ [DURATION]: 0.12 });
  });

  it("merges KEY BY KEY — an override on one rate leaves the others inherited", () => {
    // A model with both a token rate and a per-image rate: overriding the image
    // rate must not silently unprice its tokens.
    const rows = buildModelRows([
      row({
        model_id: HAIKU,
        pricing_json: JSON.stringify({ [REQ_IMAGE]: 0.02 }),
      }),
    ]);
    const haiku = find(rows, HAIKU);
    expect(haiku.effective.pricing).toEqual({ [TOK_IN]: 1, [TOK_OUT]: 5, [REQ_IMAGE]: 0.02 });
  });

  it("honors an explicitly-cleared inference profile", () => {
    const rows = buildModelRows([row({ model_id: HAIKU, inference_profile_cleared: true })]);
    const haiku = find(rows, HAIKU);
    expect(haiku.effective.inferenceProfileId).toBeNull();
    expect(haiku.override.inferenceProfileId).toBeNull();
  });

  it("appends an operator-defined model (no platform row) with source=user", () => {
    const rows = buildModelRows([
      row({
        model_id: "acme.custom-1",
        provider: "openai",
        pricing_json: JSON.stringify({ [TOK_IN]: 0.5 / 1e6, [TOK_OUT]: 1.5 / 1e6 }),
      }),
    ]);
    const custom = find(rows, "acme.custom-1");
    expect(custom.source).toBe("user");
    expect(custom.platform).toBeNull();
    expect(custom.effective.provider).toBe("openai");
    expect(custom.effective.pricing[TOK_IN]).toBe(0.5);
    expect(rows).toHaveLength(PLATFORM_MODEL_REGISTRY.length + 1);
  });

  it("lets an operator-defined model DECLARE a non-text modality", () => {
    const rows = buildModelRows([
      row({
        model_id: "acme.video-1",
        provider: "amazon",
        output_modality: "video",
        pricing_json: JSON.stringify({ [DURATION]: 0.05 }),
      }),
    ]);
    const custom = find(rows, "acme.video-1");
    expect(custom.effective.outputModality).toBe("video");
    expect(custom.override.outputModality).toBe("video");
  });

  it("defaults an operator-defined model with no stored modality to text", () => {
    const rows = buildModelRows([row({ model_id: "acme.custom-2", provider: "openai" })]);
    expect(find(rows, "acme.custom-2").effective.outputModality).toBe("text");
  });

  it("IGNORES a stored modality on a platform model (modality is intrinsic)", () => {
    // Mirrors effectiveModel(): you never re-purpose Haiku as a video model, so
    // a stray stored value must not change the delivery channel.
    const rows = buildModelRows([row({ model_id: HAIKU, output_modality: "video" })]);
    expect(find(rows, HAIKU).effective.outputModality).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// rowToOverride — what the broker's merge logic consumes
// ---------------------------------------------------------------------------

describe("rowToOverride", () => {
  it("passes the whole price table through, not just token keys", () => {
    const o = rowToOverride(
      row({ model_id: CANVAS, pricing_json: JSON.stringify({ [REQ_IMAGE]: 0.05 }) }),
    );
    expect(o.pricing).toEqual({ [REQ_IMAGE]: 0.05 });
  });

  it("passes the output modality through for an operator-defined model", () => {
    expect(rowToOverride(row({ model_id: "acme.v", output_modality: "audio" })).outputModality).toBe(
      "audio",
    );
    expect(rowToOverride(row({ model_id: "acme.v" })).outputModality).toBeUndefined();
  });

  it("omits pricing entirely when the blob has no numeric entries", () => {
    expect(rowToOverride(row({ model_id: HAIKU, pricing_json: "{}" })).pricing).toBeUndefined();
    expect(
      rowToOverride(row({ model_id: HAIKU, pricing_json: '{"input:tokens":"2"}' })).pricing,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// overrideInputToColumns
// ---------------------------------------------------------------------------

describe("overrideInputToColumns", () => {
  it("stores token rates divided down to USD per single token", () => {
    const cols = overrideInputToColumns({ pricing: { [TOK_IN]: 3, [TOK_OUT]: 15 } });
    expect(JSON.parse(cols.pricing_json!)).toEqual({ [TOK_IN]: 3 / 1e6, [TOK_OUT]: 15 / 1e6 });
  });

  it("stores a per-image / per-second rate UNSCALED", () => {
    const cols = overrideInputToColumns({ pricing: { [REQ_IMAGE]: 0.04, [DURATION]: 0.08 } });
    expect(JSON.parse(cols.pricing_json!)).toEqual({ [REQ_IMAGE]: 0.04, [DURATION]: 0.08 });
  });

  it("PRESERVES non-token rates alongside token rates in one save", () => {
    // The old editor could only send a token pair, so this combination was
    // unreachable and any save dropped the non-token key.
    const cols = overrideInputToColumns({
      pricing: { [TOK_IN]: 1, [TOK_OUT]: 2, [REQ_IMAGE]: 0.04 },
    });
    expect(JSON.parse(cols.pricing_json!)).toEqual({
      [TOK_IN]: 1e-6,
      [TOK_OUT]: 2e-6,
      [REQ_IMAGE]: 0.04,
    });
  });

  it("writes no pricing at all for an absent or empty table", () => {
    expect(overrideInputToColumns({}).pricing_json).toBeNull();
    expect(overrideInputToColumns({ pricing: {} }).pricing_json).toBeNull();
  });

  it("writes a zero rate (0 is a price, not 'unset')", () => {
    expect(overrideInputToColumns({ pricing: { [TOK_IN]: 0, [TOK_OUT]: 0 } }).pricing_json).toBe(
      JSON.stringify({ [TOK_IN]: 0, [TOK_OUT]: 0 }),
    );
  });

  it("drops a non-finite rate rather than persisting NaN/Infinity as a price", () => {
    const cols = overrideInputToColumns({
      pricing: { [TOK_IN]: Number.NaN, [REQ_IMAGE]: 0.04 } as Record<string, number>,
    });
    expect(JSON.parse(cols.pricing_json!)).toEqual({ [REQ_IMAGE]: 0.04 });
  });

  it("maps a null inferenceProfileId to cleared, a string to set, absent to inherit", () => {
    expect(overrideInputToColumns({ inferenceProfileId: null })).toMatchObject({
      inference_profile_cleared: true,
      inference_profile_id: null,
    });
    expect(overrideInputToColumns({ inferenceProfileId: "us.x.y" })).toMatchObject({
      inference_profile_cleared: false,
      inference_profile_id: "us.x.y",
    });
    expect(overrideInputToColumns({})).toMatchObject({
      inference_profile_cleared: false,
      inference_profile_id: null,
      provider: null,
      vision: null,
      output_modality: null,
      pricing_json: null,
      estimates_json: null,
    });
  });

  it("writes estimates_json only for a numeric imageTokens", () => {
    expect(overrideInputToColumns({ imageTokens: 900 }).estimates_json).toBe(
      JSON.stringify({ imageTokens: 900 }),
    );
    expect(overrideInputToColumns({}).estimates_json).toBeNull();
    expect(overrideInputToColumns({ imageTokens: 0 }).estimates_json).toBe(
      JSON.stringify({ imageTokens: 0 }),
    );
  });

  it("round-trips through the DSQL row shape (mixed pricing + modality preserved)", () => {
    const input: ModelOverrideInput = {
      provider: "amazon",
      outputModality: "image",
      pricing: { [REQ_IMAGE]: 0.04, [TOK_IN]: 0.06, [TOK_OUT]: 0.24 },
      vision: true,
      imageTokens: 1300,
    };
    const cols = overrideInputToColumns(input);
    const back = rowToOverrideInput({ model_id: "acme.image-1", ...cols });
    expect(back).toEqual(input);
  });
});

describe("isEmptyOverride", () => {
  it("is true only for an override that carries nothing", () => {
    expect(isEmptyOverride(overrideInputToColumns({}))).toBe(true);
  });

  it("is false for each individually-set field", () => {
    const cases: ModelOverrideInput[] = [
      { provider: "amazon" },
      { inferenceProfileId: "us.x.y" },
      { inferenceProfileId: null }, // an explicit clear IS an override
      { vision: false },
      { outputModality: "video" },
      { pricing: { [REQ_IMAGE]: 0.04 } },
      { imageTokens: 0 },
    ];
    for (const c of cases) {
      expect(isEmptyOverride(overrideInputToColumns(c)), JSON.stringify(c)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// validatePricing — the write route's guard
// ---------------------------------------------------------------------------

describe("validatePricing", () => {
  it("accepts an absent table and every metered key", () => {
    expect(validatePricing(undefined)).toBeNull();
    for (const key of PRICEABLE_DIMENSION_UNITS) {
      // Token keys are only valid as a pair; check them together below.
      if (key === TOK_IN || key === TOK_OUT) continue;
      expect(validatePricing({ [key]: 1 }), key).toBeNull();
    }
    expect(validatePricing({ [TOK_IN]: 1, [TOK_OUT]: 2 })).toBeNull();
  });

  it("rejects a key that is not a metered (dimension, unit) pair", () => {
    // A price on an unknown key would never be applied by deriveCostUsd — the
    // model would read as "priced" while contributing nothing to the cost gate.
    for (const key of ["input:widgets", "gpu:seconds", "tokens", "", "input:"]) {
      expect(validatePricing({ [key]: 1 }), key).toMatch(/not a metered/);
    }
  });

  it("rejects cost:usd as a rate (it is the derived total, not a price)", () => {
    // cost:usd IS a metered pair, so this is caught by the priceable list, not
    // by isKnownDimensionUnit — assert the editor can't offer it.
    expect(PRICEABLE_DIMENSION_UNITS).not.toContain("cost:usd");
  });

  it("rejects a non-numeric, negative, or non-finite rate", () => {
    expect(validatePricing({ [REQ_IMAGE]: "1" as unknown as number })).toMatch(/non-negative/);
    expect(validatePricing({ [REQ_IMAGE]: -0.01 })).toMatch(/non-negative/);
    expect(validatePricing({ [REQ_IMAGE]: Number.NaN })).toMatch(/non-negative/);
    expect(validatePricing({ [REQ_IMAGE]: Number.POSITIVE_INFINITY })).toMatch(/non-negative/);
    expect(validatePricing({ [REQ_IMAGE]: 0 })).toBeNull();
  });

  it("still enforces the TOKEN pair (half a rate under-counts every call)", () => {
    expect(validatePricing({ [TOK_IN]: 1 })).toBe("input and output $/MTok must be set together");
    expect(validatePricing({ [TOK_OUT]: 1 })).toBe("input and output $/MTok must be set together");
    // …but a non-token model needs no pair at all.
    expect(validatePricing({ [REQ_IMAGE]: 0.04 })).toBeNull();
  });

  it("rejects a non-object pricing value", () => {
    for (const bad of [[1, 2], "nope", 42, null]) {
      expect(validatePricing(bad as unknown as Record<string, unknown>), String(bad)).toMatch(
        /must be an object/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed / partial stored values
// ---------------------------------------------------------------------------

describe("malformed stored JSON", () => {
  it("treats an unparseable pricing/estimates blob as no override rather than throwing", () => {
    const rows = buildModelRows([
      row({ model_id: HAIKU, pricing_json: "{not json", estimates_json: "[[" }),
    ]);
    const haiku = find(rows, HAIKU);
    expect(haiku.effective.pricing).toEqual({ [TOK_IN]: 1, [TOK_OUT]: 5 }); // platform default
    expect(haiku.effective.imageTokens).toBe(1600);
    expect(haiku.override).toEqual({});
  });

  it("treats a non-object JSON value (array / scalar / null) as no override", () => {
    for (const blob of ["[1,2,3]", '"nope"', "42", "null"]) {
      const rows = buildModelRows([row({ model_id: HAIKU, pricing_json: blob })]);
      const haiku = find(rows, HAIKU);
      expect(haiku.effective.pricing[TOK_IN], blob).toBe(1);
      expect(haiku.override.pricing, blob).toBeUndefined();
    }
  });

  it("ignores only the non-numeric entries of a pricing blob", () => {
    const rows = buildModelRows([
      row({
        model_id: HAIKU,
        pricing_json: JSON.stringify({ [TOK_IN]: "2", [REQ_IMAGE]: 0.03 }),
      }),
    ]);
    const haiku = find(rows, HAIKU);
    expect(haiku.override.pricing).toEqual({ [REQ_IMAGE]: 0.03 });
    expect(haiku.effective.pricing[TOK_IN]).toBe(1); // platform default survives
  });

  it("surfaces the half of a partially-priced row that is a number", () => {
    const rows = buildModelRows([
      row({ model_id: HAIKU, pricing_json: JSON.stringify({ [TOK_IN]: 2 / 1e6 }) }),
    ]);
    const haiku = find(rows, HAIKU);
    expect(haiku.override.pricing).toEqual({ [TOK_IN]: 2 });
    // …and the un-overridden half still falls through to the platform rate.
    expect(haiku.effective.pricing[TOK_OUT]).toBe(5);
  });

  it("ignores a non-numeric imageTokens estimate", () => {
    const rows = buildModelRows([
      row({ model_id: HAIKU, estimates_json: JSON.stringify({ imageTokens: "lots" }) }),
    ]);
    expect(find(rows, HAIKU).effective.imageTokens).toBe(1600);
  });
});
