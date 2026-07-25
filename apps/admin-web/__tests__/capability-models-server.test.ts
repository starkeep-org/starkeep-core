import { describe, it, expect } from "vitest";
import { PLATFORM_MODEL_REGISTRY } from "@starkeep/protocol-primitives";
import {
  buildModelRows,
  overrideInputToColumns,
  rowToOverrideInput,
  type OverrideRow,
} from "../src/lib/capability-models-server";
import type { ModelOverrideInput } from "../src/lib/capability-models";

/** A DSQL row with all-null override columns unless overridden. */
function row(over: Partial<OverrideRow> & { model_id: string }): OverrideRow {
  return {
    provider: null,
    inference_profile_id: null,
    inference_profile_cleared: null,
    vision: null,
    pricing_json: null,
    estimates_json: null,
    ...over,
  };
}

const HAIKU = "anthropic.claude-haiku-4-5";

describe("buildModelRows (no overrides)", () => {
  const rows = buildModelRows([]);

  it("returns every platform model, all source=platform with empty overrides", () => {
    expect(rows).toHaveLength(PLATFORM_MODEL_REGISTRY.length);
    expect(rows.every((r) => r.source === "platform")).toBe(true);
    expect(rows.every((r) => Object.keys(r.override).length === 0)).toBe(true);
  });

  it("exposes platform pricing in $/MTok (haiku $1 in / $5 out)", () => {
    const haiku = rows.find((r) => r.modelId === HAIKU)!;
    expect(haiku.effective.inputPerMTok).toBe(1);
    expect(haiku.effective.outputPerMTok).toBe(5);
    expect(haiku.effective.vision).toBe(true);
    expect(haiku.platform).toEqual(haiku.effective);
  });
});

describe("buildModelRows (with overrides)", () => {
  it("merges a pricing override into effective, keeps source=platform", () => {
    const rows = buildModelRows([
      row({ model_id: HAIKU, pricing_json: JSON.stringify({ "input:tokens": 2 / 1e6, "output:tokens": 8 / 1e6 }) }),
    ]);
    const haiku = rows.find((r) => r.modelId === HAIKU)!;
    expect(haiku.effective.inputPerMTok).toBe(2);
    expect(haiku.effective.outputPerMTok).toBe(8);
    expect(haiku.source).toBe("platform");
    // Un-overridden platform default is still exposed for the editor.
    expect(haiku.platform!.inputPerMTok).toBe(1);
    expect(haiku.override.inputPerMTok).toBe(2);
  });

  it("honors an explicitly-cleared inference profile", () => {
    const rows = buildModelRows([row({ model_id: HAIKU, inference_profile_cleared: true })]);
    const haiku = rows.find((r) => r.modelId === HAIKU)!;
    expect(haiku.effective.inferenceProfileId).toBeNull();
    expect(haiku.override.inferenceProfileId).toBeNull();
  });

  it("appends an operator-defined model (no platform row) with source=user", () => {
    const rows = buildModelRows([
      row({
        model_id: "acme.custom-1",
        provider: "openai",
        pricing_json: JSON.stringify({ "input:tokens": 0.5 / 1e6, "output:tokens": 1.5 / 1e6 }),
      }),
    ]);
    const custom = rows.find((r) => r.modelId === "acme.custom-1")!;
    expect(custom.source).toBe("user");
    expect(custom.platform).toBeNull();
    expect(custom.effective.provider).toBe("openai");
    expect(custom.effective.inputPerMTok).toBe(0.5);
    expect(rows).toHaveLength(PLATFORM_MODEL_REGISTRY.length + 1);
  });
});

describe("overrideInputToColumns", () => {
  it("stores pricing as a per-token table under the token keys", () => {
    const cols = overrideInputToColumns({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(JSON.parse(cols.pricing_json!)).toEqual({ "input:tokens": 3 / 1e6, "output:tokens": 15 / 1e6 });
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
      pricing_json: null,
      estimates_json: null,
    });
  });

  it("round-trips through the DSQL row shape (pricing + estimates preserved)", () => {
    const input: ModelOverrideInput = {
      provider: "amazon",
      inputPerMTok: 0.06,
      outputPerMTok: 0.24,
      vision: true,
      imageTokens: 1300,
    };
    const cols = overrideInputToColumns(input);
    const back = rowToOverrideInput({ model_id: "amazon.nova-lite", ...cols });
    expect(back).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// Malformed / partial stored values
// ---------------------------------------------------------------------------

describe("malformed stored JSON", () => {
  it("treats an unparseable pricing/estimates blob as no override rather than throwing", () => {
    // A hand-edited or truncated row must degrade to the platform default, not
    // take the whole registry read down.
    const rows = buildModelRows([
      row({ model_id: HAIKU, pricing_json: "{not json", estimates_json: "[[" }),
    ]);
    const haiku = rows.find((r) => r.modelId === HAIKU)!;
    expect(haiku.effective.inputPerMTok).toBe(1); // platform default
    expect(haiku.effective.imageTokens).toBe(1600);
    expect(haiku.override).toEqual({});
  });

  it("treats a non-object JSON value (array / scalar / null) as no override", () => {
    for (const blob of ["[1,2,3]", '"nope"', "42", "null"]) {
      const rows = buildModelRows([row({ model_id: HAIKU, pricing_json: blob })]);
      const haiku = rows.find((r) => r.modelId === HAIKU)!;
      expect(haiku.effective.inputPerMTok, blob).toBe(1);
      expect(haiku.override.inputPerMTok, blob).toBeUndefined();
    }
  });

  it("ignores a pricing blob whose values are not numbers", () => {
    const rows = buildModelRows([
      row({ model_id: HAIKU, pricing_json: JSON.stringify({ "input:tokens": "2" }) }),
    ]);
    const haiku = rows.find((r) => r.modelId === HAIKU)!;
    expect(haiku.override.inputPerMTok).toBeUndefined();
  });

  it("surfaces only the half of a partially-priced row that is a number", () => {
    const rows = buildModelRows([
      row({ model_id: HAIKU, pricing_json: JSON.stringify({ "input:tokens": 2 / 1e6 }) }),
    ]);
    const haiku = rows.find((r) => r.modelId === HAIKU)!;
    expect(haiku.override.inputPerMTok).toBe(2);
    expect(haiku.override.outputPerMTok).toBeUndefined();
    // …and the un-overridden half still falls through to the platform rate.
    expect(haiku.effective.outputPerMTok).toBe(5);
  });
});

describe("overrideInputToColumns — the pricing pair", () => {
  it("writes pricing_json ONLY when both halves are numbers", () => {
    expect(overrideInputToColumns({ inputPerMTok: 2, outputPerMTok: 8 }).pricing_json).toBe(
      JSON.stringify({ "input:tokens": 2 / 1e6, "output:tokens": 8 / 1e6 }),
    );
    // A half-set pair writes NO pricing at all — the API rejects it upstream,
    // but if it ever got here the row must not silently persist half a rate.
    expect(overrideInputToColumns({ inputPerMTok: 2 }).pricing_json).toBeNull();
    expect(overrideInputToColumns({ outputPerMTok: 8 }).pricing_json).toBeNull();
  });

  it("writes a zero-priced pair (0 is a rate, not 'unset')", () => {
    expect(overrideInputToColumns({ inputPerMTok: 0, outputPerMTok: 0 }).pricing_json).toBe(
      JSON.stringify({ "input:tokens": 0, "output:tokens": 0 }),
    );
  });

  it("OVERWRITES pricing_json wholesale — non-token rates set elsewhere are dropped", () => {
    // Known limitation: the editor can only express token pricing, so saving any
    // override through it replaces the whole pricing table. A model priced on
    // requests:image / output:duration_s loses that rate on save.
    const cols = overrideInputToColumns({ inputPerMTok: 1, outputPerMTok: 2 });
    expect(JSON.parse(cols.pricing_json!)).toEqual({
      "input:tokens": 1e-6,
      "output:tokens": 2e-6,
    });
    expect(JSON.parse(cols.pricing_json!)["requests:image"]).toBeUndefined();
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
});
