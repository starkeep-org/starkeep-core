import { describe, it, expect } from "vitest";
import {
  // dimensions
  dimensionUnitKey,
  isKnownDimensionUnit,
  isCdsMeasured,
  isNonGenericDimensionUnit,
  REPORTABLE_DIMENSION_UNITS,
  // registry
  CAPABILITY_BEDROCK_INVOKE,
  isKnownCapability,
  isReservedCapabilityName,
  // models
  effectiveModel,
  isModelInEffectiveRegistry,
  bedrockInvokeTarget,
  perMTok,
  type OperatorModelOverride,
  // gates
  gateMatches,
  evaluateGates,
  projectReservation,
  reconcileMeasurements,
  deriveCostUsd,
  type Gate,
  type Measurement,
  type CapabilityRequestContext,
  // grants
  buildCapabilityGrant,
  canInvokeModel,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

describe("dimension model", () => {
  it("classifies CDS-measured vs app-reported sources", () => {
    // The load-bearing spend cap set: all CDS-measured.
    expect(isCdsMeasured("requests", "all")).toBe(true);
    expect(isCdsMeasured("input", "bytes")).toBe(true);
    expect(isCdsMeasured("output", "bytes")).toBe(true);
    expect(isCdsMeasured("input", "tokens")).toBe(true);
    expect(isCdsMeasured("output", "tokens")).toBe(true);
    expect(isCdsMeasured("cost", "usd")).toBe(true);
    // App-reported: only as trustworthy as the app.
    expect(isCdsMeasured("input", "megapixels")).toBe(false);
    expect(isCdsMeasured("output", "duration_s")).toBe(false);
    expect(isCdsMeasured("requests", "image")).toBe(false);
    expect(isCdsMeasured("credits", "count")).toBe(false);
  });

  it("marks generic pairs non-declarable and non-generic pairs declarable", () => {
    expect(isNonGenericDimensionUnit("requests", "all")).toBe(false);
    expect(isNonGenericDimensionUnit("cost", "usd")).toBe(false);
    expect(isNonGenericDimensionUnit("input", "bytes")).toBe(false);
    expect(isNonGenericDimensionUnit("input", "megapixels")).toBe(true);
    expect(isNonGenericDimensionUnit("requests", "image")).toBe(true);
    // reportable set == exactly the non-generic pairs
    expect(REPORTABLE_DIMENSION_UNITS).toContain(dimensionUnitKey("input", "megapixels"));
    expect(REPORTABLE_DIMENSION_UNITS).not.toContain(dimensionUnitKey("cost", "usd"));
  });

  it("rejects unknown dimension/unit pairs", () => {
    expect(isKnownDimensionUnit("input", "tokens")).toBe(true);
    expect(isKnownDimensionUnit("input", "furlongs")).toBe(false);
    expect(isKnownDimensionUnit("bogus", "all")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Capability registry
// ---------------------------------------------------------------------------

describe("capability registry", () => {
  it("knows bedrock.invoke and rejects invented/reserved names", () => {
    expect(isKnownCapability(CAPABILITY_BEDROCK_INVOKE)).toBe(true);
    expect(isKnownCapability("bedrock.knowledgeBase")).toBe(false);
    expect(isReservedCapabilityName("bedrock.knowledgeBase")).toBe(true);
    expect(isReservedCapabilityName("bedrock.invoke")).toBe(false);
    expect(isKnownCapability("totally.madeup")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Model registry (two layered tables)
// ---------------------------------------------------------------------------

describe("model registry", () => {
  it("resolves a platform model with its inference profile as invoke target", () => {
    const m = effectiveModel("anthropic.claude-haiku-4-5");
    expect(m?.source).toBe("platform");
    expect(m?.provider).toBe("anthropic");
    expect(m?.vision).toBe(true);
    expect(bedrockInvokeTarget(m!)).toBe("us.anthropic.claude-haiku-4-5");
    expect(m?.pricing[dimensionUnitKey("input", "tokens")]).toBeCloseTo(perMTok(1));
  });

  it("returns undefined for an unknown model", () => {
    expect(effectiveModel("nope.nope")).toBeUndefined();
    expect(isModelInEffectiveRegistry("nope.nope")).toBe(false);
  });

  it("an operator override wins per-field; unset fields fall through", () => {
    const overrides: OperatorModelOverride[] = [
      { modelId: "anthropic.claude-sonnet-5", pricing: { [dimensionUnitKey("input", "tokens")]: perMTok(2) } },
    ];
    const m = effectiveModel("anthropic.claude-sonnet-5", overrides)!;
    // overridden field
    expect(m.pricing[dimensionUnitKey("input", "tokens")]).toBeCloseTo(perMTok(2));
    // untouched field keeps the platform default
    expect(m.pricing[dimensionUnitKey("output", "tokens")]).toBeCloseTo(perMTok(15));
    expect(m.source).toBe("platform");
  });

  it("an operator-DEFINED model (no platform row) resolves from the override alone", () => {
    const overrides: OperatorModelOverride[] = [
      {
        modelId: "anthropic.claude-future-9",
        provider: "anthropic",
        vision: true,
        pricing: { [dimensionUnitKey("input", "tokens")]: perMTok(4) },
      },
    ];
    expect(isModelInEffectiveRegistry("anthropic.claude-future-9", overrides)).toBe(true);
    const m = effectiveModel("anthropic.claude-future-9", overrides)!;
    expect(m.source).toBe("user");
    expect(m.provider).toBe("anthropic");
  });

  it("an operator-defined model without a provider is not gate/meter-able", () => {
    const overrides: OperatorModelOverride[] = [{ modelId: "mystery.x", pricing: {} }];
    expect(effectiveModel("mystery.x", overrides)).toBeUndefined();
  });

  it("clearing the inference profile via null override falls back to the bare id", () => {
    const overrides: OperatorModelOverride[] = [
      { modelId: "anthropic.claude-haiku-4-5", inferenceProfileId: null },
    ];
    const m = effectiveModel("anthropic.claude-haiku-4-5", overrides)!;
    expect(m.inferenceProfileId).toBeUndefined();
    expect(bedrockInvokeTarget(m)).toBe("anthropic.claude-haiku-4-5");
  });
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

describe("capability grants", () => {
  it("gates model invocation against the approved set", () => {
    const grant = buildCapabilityGrant({
      appId: "photos",
      capabilityName: CAPABILITY_BEDROCK_INVOKE,
      models: ["anthropic.claude-haiku-4-5"],
      reports: [dimensionUnitKey("input", "megapixels")],
    });
    expect(canInvokeModel(grant, "anthropic.claude-haiku-4-5")).toBe(true);
    expect(canInvokeModel(grant, "anthropic.claude-opus-4-8")).toBe(false);
    expect(grant.reports.has("input:megapixels")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate matching + evaluation (the security-critical core)
// ---------------------------------------------------------------------------

const HAIKU = effectiveModel("anthropic.claude-haiku-4-5")!;
const ctx: CapabilityRequestContext = {
  appId: "photos",
  provider: "anthropic",
  model: "anthropic.claude-haiku-4-5",
  modality: "image",
};

function gate(partial: Partial<Gate> & Pick<Gate, "dimension" | "unit" | "limit">): Gate {
  return {
    scope: {},
    window: { kind: "calendar", period: "month" },
    onExceed: "deny",
    ...partial,
  };
}

describe("gate matching", () => {
  it("wildcards omitted scope keys; matches on set keys", () => {
    expect(gateMatches(gate({ dimension: "cost", unit: "usd", limit: 1 }), ctx)).toBe(true);
    expect(gateMatches(gate({ dimension: "cost", unit: "usd", limit: 1, scope: { appId: "photos" } }), ctx)).toBe(true);
    expect(gateMatches(gate({ dimension: "cost", unit: "usd", limit: 1, scope: { appId: "notes" } }), ctx)).toBe(false);
    expect(gateMatches(gate({ dimension: "cost", unit: "usd", limit: 1, scope: { provider: "anthropic" } }), ctx)).toBe(true);
    expect(gateMatches(gate({ dimension: "cost", unit: "usd", limit: 1, scope: { provider: "openai" } }), ctx)).toBe(false);
    expect(gateMatches(gate({ dimension: "cost", unit: "usd", limit: 1, scope: { model: "anthropic.claude-haiku-4-5" } }), ctx)).toBe(true);
  });
});

// A trivial in-memory ledger sum: committed measurements plus reservations.
function makeLedger(rows: Measurement[]) {
  return async (g: Gate) => {
    let total = 0;
    for (const m of rows) {
      if (m.dimension === g.dimension && m.unit === g.unit) total += m.quantity;
    }
    return total;
  };
}

const ALL_DECLARED = new Set([
  dimensionUnitKey("input", "megapixels"),
  dimensionUnitKey("requests", "image"),
]);

describe("gate evaluation", () => {
  it("allows when no gate is set", async () => {
    const projected = projectReservation({ model: HAIKU, ctx, imageCount: 1, maxTokens: 500 });
    const d = await evaluateGates({ gates: [], ctx, appReports: ALL_DECLARED, projected, getSum: makeLedger([]) });
    expect(d.allowed).toBe(true);
  });

  it("denies when a matching cost gate would be exceeded", async () => {
    const projected = projectReservation({ model: HAIKU, ctx, imageCount: 1, maxTokens: 1_000_000 });
    // reservation cost = 1600 imgTok * $1/MTok + 1e6 outTok * $5/MTok ≈ $5.0016
    const g = gate({ dimension: "cost", unit: "usd", limit: 1 });
    const d = await evaluateGates({ gates: [g], ctx, appReports: ALL_DECLARED, projected, getSum: makeLedger([]) });
    expect(d.allowed).toBe(false);
    expect(d.breaches[0].kind).toBe("exceeded");
  });

  it("respects existing ledger usage (reserve-on-ledger)", async () => {
    const projected = projectReservation({ model: HAIKU, ctx, imageCount: 1, maxTokens: 10 });
    const g = gate({ dimension: "requests", unit: "all", limit: 5 });
    // 5 already used → the 6th (this) request breaches.
    const used = Array.from({ length: 5 }, () => ({ dimension: "requests", unit: "all", quantity: 1 }));
    const d = await evaluateGates({ gates: [g], ctx, appReports: ALL_DECLARED, projected, getSum: makeLedger(used) });
    expect(d.allowed).toBe(false);
    expect(d.breaches[0].kind).toBe("exceeded");
    expect(d.breaches[0].current).toBe(5);
  });

  it("allows exactly at the boundary and denies one past it", async () => {
    const projected: Measurement[] = [{ dimension: "requests", unit: "all", quantity: 1 }];
    const g = gate({ dimension: "requests", unit: "all", limit: 5 });
    const atBoundary = Array.from({ length: 4 }, () => ({ dimension: "requests", unit: "all", quantity: 1 }));
    const ok = await evaluateGates({ gates: [g], ctx, appReports: ALL_DECLARED, projected, getSum: makeLedger(atBoundary) });
    expect(ok.allowed).toBe(true); // 4 + 1 == 5, not > 5
    const over = Array.from({ length: 5 }, () => ({ dimension: "requests", unit: "all", quantity: 1 }));
    const bad = await evaluateGates({ gates: [g], ctx, appReports: ALL_DECLARED, projected, getSum: makeLedger(over) });
    expect(bad.allowed).toBe(false); // 5 + 1 == 6 > 5
  });

  it("FAILS CLOSED on a gate targeting an undeclared non-generic dimension", async () => {
    const projected = projectReservation({ model: HAIKU, ctx, imageCount: 1, maxTokens: 10 });
    const g = gate({ dimension: "input", unit: "megapixels", limit: 1_000_000 });
    // app has NOT declared input:megapixels
    const d = await evaluateGates({
      gates: [g],
      ctx,
      appReports: new Set<string>(),
      projected,
      getSum: makeLedger([]),
    });
    expect(d.allowed).toBe(false);
    expect(d.breaches[0].kind).toBe("undeclared");
  });

  it("an app under-reporting an app-reported dimension is still bounded by CDS-measured gates", async () => {
    // The app claims 0 megapixels (under-report) but the CDS-measured request
    // count gate still holds.
    const projected = projectReservation({
      model: HAIKU,
      ctx,
      imageCount: 1,
      maxTokens: 10,
      appReports: { [dimensionUnitKey("input", "megapixels")]: 0 },
    });
    const gates = [
      gate({ dimension: "input", unit: "megapixels", limit: 100 }), // app dodges this
      gate({ dimension: "requests", unit: "all", limit: 0 }), // CDS-measured, hard
    ];
    const d = await evaluateGates({ gates, ctx, appReports: ALL_DECLARED, projected, getSum: makeLedger([]) });
    expect(d.allowed).toBe(false);
    expect(d.breaches.some((b) => b.gate.dimension === "requests")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Projection + reconciliation
// ---------------------------------------------------------------------------

describe("reservation projection", () => {
  it("projects worst-case output ceiling + image-token input estimate + cost", () => {
    const p = projectReservation({ model: HAIKU, ctx, inputBytes: 2048, imageCount: 1, maxTokens: 500 });
    const byKey = (d: string, u: string) => p.find((m) => m.dimension === d && m.unit === u)?.quantity;
    expect(byKey("requests", "all")).toBe(1);
    expect(byKey("requests", "image")).toBe(1);
    expect(byKey("input", "bytes")).toBe(2048);
    expect(byKey("input", "tokens")).toBe(1600); // imageTokens default
    expect(byKey("output", "tokens")).toBe(500); // ceiling
    // cost = 1600*$1/MTok + 500*$5/MTok
    expect(byKey("cost", "usd")).toBeCloseTo(perMTok(1) * 1600 + perMTok(5) * 500);
  });
});

describe("reconciliation", () => {
  it("trues up to exact tokens and re-derives cost", () => {
    const r = reconcileMeasurements({
      model: HAIKU,
      ctx,
      inputTokens: 1234,
      outputTokens: 88,
      inputBytes: 2048,
      outputBytes: 300,
      appReports: { [dimensionUnitKey("output", "megapixels")]: 4 },
    });
    const byKey = (d: string, u: string) => r.find((m) => m.dimension === d && m.unit === u)?.quantity;
    expect(byKey("input", "tokens")).toBe(1234);
    expect(byKey("output", "tokens")).toBe(88);
    expect(byKey("output", "megapixels")).toBe(4);
    expect(byKey("cost", "usd")).toBeCloseTo(perMTok(1) * 1234 + perMTok(5) * 88);
  });
});

describe("deriveCostUsd", () => {
  it("prices only priced dimensions", () => {
    const usd = deriveCostUsd(HAIKU.pricing, [
      { dimension: "input", unit: "tokens", quantity: 1_000_000 },
      { dimension: "output", unit: "tokens", quantity: 1_000_000 },
      { dimension: "input", unit: "megapixels", quantity: 999 }, // unpriced → ignored
    ]);
    expect(usd).toBeCloseTo(1 + 5);
  });
});

import { windowStartMs, calendarPeriodStartMs } from "../src/index.js";

describe("gate windows", () => {
  it("burst window is now - seconds", () => {
    const now = 1_000_000_000;
    expect(windowStartMs({ kind: "burst", seconds: 60 }, now)).toBe(now - 60_000);
  });

  it("month start in UTC is the 1st at 00:00", () => {
    const now = Date.UTC(2026, 6, 23, 15, 30); // 2026-07-23T15:30Z
    const start = calendarPeriodStartMs("month", now, "UTC");
    expect(new Date(start).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("week start is the preceding Monday 00:00 (UTC)", () => {
    // 2026-07-23 is a Thursday → Monday is 2026-07-20.
    const now = Date.UTC(2026, 6, 23, 15, 30);
    const start = calendarPeriodStartMs("week", now, "UTC");
    expect(new Date(start).toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  it("aligns the month boundary to a non-UTC timezone", () => {
    // 2026-07-01T02:00Z is still June 30 in America/Los_Angeles (UTC-7),
    // so the LA month start is 2026-06-01T00:00 local = 2026-06-01T07:00Z.
    const now = Date.UTC(2026, 6, 1, 2, 0);
    const start = calendarPeriodStartMs("month", now, "America/Los_Angeles");
    expect(new Date(start).toISOString()).toBe("2026-06-01T07:00:00.000Z");
  });
});
