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
