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
  outputIsAsyncS3,
  outputDelivery,
  outputIsSyncInvoke,
  perMTok,
  type OperatorModelOverride,
  // gates
  gateMatches,
  evaluateGates,
  projectReservation,
  reconcileMeasurements,
  projectAsyncReservation,
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
    // haiku-4-5 has no unversioned cross-region profile alias (unlike
    // sonnet-5 / opus-4-8), so its on-demand target is the dated id.
    expect(bedrockInvokeTarget(m!)).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
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

describe("output modality → delivery channel (plan §3.8)", () => {
  it("resolves Nova Reel as a video-output model priced per output second", () => {
    const m = effectiveModel("amazon.nova-reel-v1:1")!;
    expect(m.outputModality).toBe("video");
    expect(outputIsAsyncS3(m.outputModality)).toBe(true); // video ⇒ async S3
    expect(m.provider).toBe("amazon");
    expect(m.pricing[dimensionUnitKey("output", "duration_s")]).toBeCloseTo(0.08);
  });

  it("a text model defaults to text output (inline/streamed, not async)", () => {
    const m = effectiveModel("anthropic.claude-haiku-4-5")!;
    expect(m.outputModality).toBe("text");
    expect(outputIsAsyncS3(m.outputModality)).toBe(false);
  });

  it("outputDelivery routes the three channels by modality (§3.8)", () => {
    // text = inline; image = sync-s3 (CDS-written, synchronous); audio/video = async-s3.
    expect(outputDelivery("text")).toBe("inline");
    expect(outputDelivery("image")).toBe("sync-s3");
    expect(outputDelivery("audio")).toBe("async-s3");
    expect(outputDelivery("video")).toBe("async-s3");
  });

  it("outputIsAsyncS3 is async ONLY — image is sync-s3, not async (Nova Canvas is synchronous)", () => {
    expect(outputIsAsyncS3("text")).toBe(false);
    expect(outputIsAsyncS3("image")).toBe(false); // sync image, was true before 2026-07-25
    expect(outputIsAsyncS3("audio")).toBe(true);
    expect(outputIsAsyncS3("video")).toBe(true);
  });

  it("outputIsSyncInvoke covers the synchronous /invoke channels (text + image)", () => {
    expect(outputIsSyncInvoke("text")).toBe(true);
    expect(outputIsSyncInvoke("image")).toBe(true);
    expect(outputIsSyncInvoke("audio")).toBe(false);
    expect(outputIsSyncInvoke("video")).toBe(false);
  });

  it("Nova Canvas is a synchronous sync-s3 image model priced per image", () => {
    const m = effectiveModel("amazon.nova-canvas-v1:0")!;
    expect(m.outputModality).toBe("image");
    expect(outputDelivery(m.outputModality)).toBe("sync-s3");
    expect(outputIsAsyncS3(m.outputModality)).toBe(false);
    expect(m.provider).toBe("amazon");
    expect(m.pricing[dimensionUnitKey("requests", "image")]).toBeCloseTo(0.04);
  });

  it("an operator DEFINES a new non-text model's modality (add-a-custom-model, no platform row)", () => {
    const m = effectiveModel("acme.video-1", [
      {
        modelId: "acme.video-1",
        provider: "amazon",
        outputModality: "video",
        pricing: { [dimensionUnitKey("output", "duration_s")]: 0.2 },
      },
    ])!;
    expect(m.outputModality).toBe("video");
    expect(m.source).toBe("user");
  });

  it("output modality is intrinsic: an override CANNOT re-point a platform model's modality", () => {
    const m = effectiveModel("anthropic.claude-haiku-4-5", [
      { modelId: "anthropic.claude-haiku-4-5", outputModality: "video" },
    ])!;
    // Platform wins — Haiku stays text output; the override's modality is ignored.
    expect(m.outputModality).toBe("text");
    // Other (drift-prone) fields still override normally.
    const priced = effectiveModel("anthropic.claude-haiku-4-5", [
      { modelId: "anthropic.claude-haiku-4-5", outputModality: "video", pricing: { [dimensionUnitKey("input", "tokens")]: perMTok(9) } },
    ])!;
    expect(priced.pricing[dimensionUnitKey("input", "tokens")]).toBeCloseTo(perMTok(9));
  });
});

describe("async reservation + reconciliation (plan §3.8)", () => {
  const NOVA = effectiveModel("amazon.nova-reel-v1:1")!;
  const videoCtx: CapabilityRequestContext = {
    appId: "photos",
    provider: "amazon",
    model: "amazon.nova-reel-v1:1",
    modality: "video",
  };

  it("reserves requests + input bytes + CDS-derived duration, and prices cost from it", () => {
    const p = projectAsyncReservation({
      model: NOVA,
      ctx: videoCtx,
      inputBytes: 4096,
      output: [{ dimension: "output", unit: "duration_s", quantity: 6 }],
    });
    const byKey = (d: string, u: string) => p.find((m) => m.dimension === d && m.unit === u)?.quantity;
    expect(byKey("requests", "all")).toBe(1);
    expect(byKey("requests", "video")).toBe(1);
    expect(byKey("input", "bytes")).toBe(4096);
    expect(byKey("output", "duration_s")).toBe(6);
    // No output-token ceiling for generation.
    expect(byKey("output", "tokens")).toBeUndefined();
    // Load-bearing cost gate is CDS-derived from the requested duration.
    expect(byKey("cost", "usd")).toBeCloseTo(6 * 0.08);
  });

  it("reserves app-reported input quantities but never an output-token ceiling", () => {
    const p = projectAsyncReservation({
      model: NOVA,
      ctx: videoCtx,
      output: [{ dimension: "output", unit: "duration_s", quantity: 6 }],
      appReports: { [dimensionUnitKey("input", "megapixels")]: 2 },
    });
    const byKey = (d: string, u: string) => p.find((m) => m.dimension === d && m.unit === u)?.quantity;
    expect(byKey("input", "megapixels")).toBe(2);
    expect(byKey("output", "tokens")).toBeUndefined();
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

// ---------------------------------------------------------------------------
// P2 completeness: gate evaluation determinism, window edges, projection edges
// ---------------------------------------------------------------------------

import {
  lookupDimensionUnit,
  DIMENSION_UNIT_SPECS,
  PLATFORM_MODEL_REGISTRY,
  CAPABILITY_REGISTRY,
  RESERVED_CAPABILITY_NAMES,
  lookupCapability,
  reconcileMeasurements as reconcile2,
} from "../src/index.js";

describe("gate evaluation completeness", () => {
  it("does NOT short-circuit: every breaching gate is reported", async () => {
    // The breaches list feeds logging/UI, so a partial list would misreport why
    // a request was denied.
    const projected: Measurement[] = [{ dimension: "requests", unit: "all", quantity: 1 }];
    const gates = [
      gate({ dimension: "requests", unit: "all", limit: 0 }),
      gate({ dimension: "cost", unit: "usd", limit: 0 }),
      gate({ dimension: "input", unit: "megapixels", limit: 1 }), // undeclared
    ];
    const d = await evaluateGates({
      gates,
      ctx,
      appReports: new Set<string>(),
      projected,
      getSum: makeLedger([
        { dimension: "requests", unit: "all", quantity: 5 },
        { dimension: "cost", unit: "usd", quantity: 1 },
      ]),
    });
    expect(d.allowed).toBe(false);
    expect(d.breaches).toHaveLength(3);
    expect(d.breaches.map((b) => b.kind).sort()).toEqual(["exceeded", "exceeded", "undeclared"]);
  });

  it("fetches a sum for every matching gate, and for no non-matching gate", async () => {
    const asked: string[] = [];
    const d = await evaluateGates({
      gates: [
        gate({ dimension: "cost", unit: "usd", limit: 100 }),
        gate({ dimension: "requests", unit: "all", limit: 100 }),
        gate({ dimension: "cost", unit: "usd", limit: 100, scope: { appId: "someone-else" } }),
      ],
      ctx,
      appReports: ALL_DECLARED,
      projected: [],
      getSum: async (g) => {
        asked.push(dimensionUnitKey(g.dimension, g.unit));
        return 0;
      },
    });
    expect(d.allowed).toBe(true);
    expect(asked).toEqual(["cost:usd", "requests:all"]);
  });

  it("does not sum a gate it already failed closed on (undeclared short-circuits that gate only)", async () => {
    let sums = 0;
    await evaluateGates({
      gates: [gate({ dimension: "input", unit: "megapixels", limit: 1 })],
      ctx,
      appReports: new Set<string>(),
      projected: [],
      getSum: async () => {
        sums++;
        return 0;
      },
    });
    expect(sums).toBe(0);
  });

  it("reports the projected contribution and the pre-request window total on a breach", async () => {
    const d = await evaluateGates({
      gates: [gate({ dimension: "requests", unit: "all", limit: 3 })],
      ctx,
      appReports: ALL_DECLARED,
      projected: [{ dimension: "requests", unit: "all", quantity: 2 }],
      getSum: makeLedger([
        { dimension: "requests", unit: "all", quantity: 2 },
      ]),
    });
    expect(d.breaches[0]!.projected).toBe(2);
    expect(d.breaches[0]!.current).toBe(2);
  });

  it("ignores projected measurements on a different (dimension, unit)", async () => {
    const d = await evaluateGates({
      gates: [gate({ dimension: "cost", unit: "usd", limit: 0 })],
      ctx,
      appReports: ALL_DECLARED,
      projected: [{ dimension: "requests", unit: "all", quantity: 999 }],
      getSum: makeLedger([]),
    });
    expect(d.allowed).toBe(true);
  });
});

describe("window boundaries", () => {
  it("windowStartMs routes the calendar branch through calendarPeriodStartMs", () => {
    const now = Date.UTC(2026, 6, 23, 15, 30);
    expect(windowStartMs({ kind: "calendar", period: "month" }, now, "UTC")).toBe(
      calendarPeriodStartMs("month", now, "UTC"),
    );
    expect(windowStartMs({ kind: "calendar", period: "week" }, now, "UTC")).toBe(
      calendarPeriodStartMs("week", now, "UTC"),
    );
  });

  it("defaults to UTC when no time zone is supplied", () => {
    const now = Date.UTC(2026, 6, 23, 15, 30);
    expect(windowStartMs({ kind: "calendar", period: "month" }, now)).toBe(
      windowStartMs({ kind: "calendar", period: "month" }, now, "UTC"),
    );
  });

  it("clamps a negative burst window to now (never widens it into the future)", () => {
    const now = 1_000_000_000;
    // A malformed gate row (negative seconds) must not produce a window that
    // starts AFTER now and silently sums nothing.
    expect(windowStartMs({ kind: "burst", seconds: -60 }, now)).toBe(now);
    expect(windowStartMs({ kind: "burst", seconds: 0 }, now)).toBe(now);
  });

  it("week start is today's midnight when today IS Monday", () => {
    // 2026-07-20 is a Monday: the window starts at its own midnight, not 7 days back.
    const monday = Date.UTC(2026, 6, 20, 9, 0);
    expect(new Date(calendarPeriodStartMs("week", monday, "UTC")).toISOString()).toBe(
      "2026-07-20T00:00:00.000Z",
    );
  });

  it("week start is 6 days back on a Sunday (Monday-start weeks)", () => {
    // 2026-07-26 is a Sunday → the week began Monday 2026-07-20.
    const sunday = Date.UTC(2026, 6, 26, 23, 0);
    expect(new Date(calendarPeriodStartMs("week", sunday, "UTC")).toISOString()).toBe(
      "2026-07-20T00:00:00.000Z",
    );
  });

  it("month start is idempotent on the 1st at midnight", () => {
    const firstMidnight = Date.UTC(2026, 6, 1, 0, 0);
    expect(calendarPeriodStartMs("month", firstMidnight, "UTC")).toBe(firstMidnight);
  });

  it("aligns a week boundary to a non-UTC zone", () => {
    // 2026-07-20T02:00Z is still Sunday 19th in Los Angeles, so LA's week began
    // Monday 2026-07-13 local = 2026-07-13T07:00Z.
    const now = Date.UTC(2026, 6, 20, 2, 0);
    expect(new Date(calendarPeriodStartMs("week", now, "America/Los_Angeles")).toISOString()).toBe(
      "2026-07-13T07:00:00.000Z",
    );
  });
});

describe("projectReservation edges", () => {
  it("omits the modality request row when the context has no modality", () => {
    const p = projectReservation({
      model: HAIKU,
      ctx: { appId: "photos", provider: "anthropic", model: "anthropic.claude-haiku-4-5" },
      maxTokens: 10,
    });
    expect(p.filter((m) => m.dimension === "requests")).toEqual([
      { dimension: "requests", unit: "all", quantity: 1 },
    ]);
  });

  it("omits input:bytes when no referenced object was read, but keeps a zero-size one", () => {
    const noBytes = projectReservation({ model: HAIKU, ctx, maxTokens: 10 });
    expect(noBytes.some((m) => m.unit === "bytes")).toBe(false);
    const zeroBytes = projectReservation({ model: HAIKU, ctx, inputBytes: 0, maxTokens: 10 });
    expect(zeroBytes.find((m) => m.unit === "bytes")?.quantity).toBe(0);
  });

  it("omits input:tokens when nothing contributes any (no prompt estimate, no image)", () => {
    const p = projectReservation({ model: HAIKU, ctx, maxTokens: 10 });
    expect(p.some((m) => m.dimension === "input" && m.unit === "tokens")).toBe(false);
  });

  it("omits the cost row entirely when the model has no pricing for anything projected", () => {
    // An operator-defined model with no price table can't derive a cost, so no
    // cost row is written (rather than a misleading $0).
    const unpriced = effectiveModel("acme.unpriced", [
      { modelId: "acme.unpriced", provider: "amazon" },
    ])!;
    const p = projectReservation({ model: unpriced, ctx, maxTokens: 10 });
    expect(p.some((m) => m.dimension === "cost")).toBe(false);
  });

  it("SILENTLY DROPS an output:-prefixed appReport from the reservation", () => {
    // Output quantities aren't knowable pre-call, so only `input:` app reports
    // are reserved; an output report arrives later via the report route.
    const p = projectReservation({
      model: HAIKU,
      ctx,
      maxTokens: 10,
      appReports: {
        [dimensionUnitKey("input", "megapixels")]: 3,
        [dimensionUnitKey("output", "megapixels")]: 9,
      },
    });
    expect(p.find((m) => m.unit === "megapixels" && m.dimension === "input")?.quantity).toBe(3);
    expect(p.some((m) => m.dimension === "output" && m.unit === "megapixels")).toBe(false);
  });

  it("drops an appReport on a GENERIC dimension (an app may not substitute a CDS measure)", () => {
    const p = projectReservation({
      model: HAIKU,
      ctx,
      inputBytes: 100,
      maxTokens: 10,
      appReports: { [dimensionUnitKey("input", "bytes")]: 999_999 },
    });
    expect(p.filter((m) => m.dimension === "input" && m.unit === "bytes")).toEqual([
      { dimension: "input", unit: "bytes", quantity: 100 },
    ]);
  });

  it("prices an image-generation request off requests:<modality>", () => {
    const canvas = effectiveModel("amazon.nova-canvas-v1:0")!;
    const p = projectReservation({
      model: canvas,
      ctx: { appId: "photos", provider: "amazon", model: canvas.modelId, modality: "image" },
      maxTokens: 1,
    });
    expect(p.find((m) => m.dimension === "cost")?.quantity).toBeCloseTo(0.04, 5);
  });
});

describe("reconcileMeasurements edges", () => {
  it("accepts a credits: app report but rejects a requests:<modality> one", () => {
    const r = reconcile2({
      model: HAIKU,
      ctx,
      inputTokens: 1,
      outputTokens: 1,
      appReports: {
        [dimensionUnitKey("credits", "count")]: 7,
        // requests:image is non-generic but is NOT an input/output/credits
        // dimension — the CDS counts requests itself.
        [dimensionUnitKey("requests", "image")]: 99,
      },
    });
    expect(r.find((m) => m.dimension === "credits")?.quantity).toBe(7);
    expect(r.filter((m) => m.dimension === "requests")).toEqual([
      { dimension: "requests", unit: "all", quantity: 1 },
      { dimension: "requests", unit: "image", quantity: 1 }, // from ctx.modality, not the report
    ]);
  });

  it("always records both token counts, even at zero (an image gen reconcile)", () => {
    const r = reconcile2({ model: HAIKU, ctx, inputTokens: 0, outputTokens: 0 });
    expect(r.find((m) => m.dimension === "input" && m.unit === "tokens")?.quantity).toBe(0);
    expect(r.find((m) => m.dimension === "output" && m.unit === "tokens")?.quantity).toBe(0);
  });

  it("omits output:bytes when the caller didn't measure any", () => {
    const r = reconcile2({ model: HAIKU, ctx, inputTokens: 1, outputTokens: 1 });
    expect(r.some((m) => m.dimension === "output" && m.unit === "bytes")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dimension specs
// ---------------------------------------------------------------------------

describe("lookupDimensionUnit", () => {
  it("returns the full spec for a known pair", () => {
    expect(lookupDimensionUnit("input", "tokens")).toEqual({
      dimension: "input",
      unit: "tokens",
      source: "cds",
      timing: "estimated",
      generic: true,
    });
  });

  it("returns undefined for an unknown pair", () => {
    expect(lookupDimensionUnit("input", "furlongs")).toBeUndefined();
    expect(lookupDimensionUnit("bogus", "all")).toBeUndefined();
  });
});

describe("the Timing axis", () => {
  const timing = (d: string, u: string) => lookupDimensionUnit(d, u)?.timing;

  it("marks pre-call-exact quantities `pre`", () => {
    // Known before the call with no estimate: the request count and the
    // S3-HEAD input size (and app-supplied input quantities).
    expect(timing("requests", "all")).toBe("pre");
    expect(timing("requests", "image")).toBe("pre");
    expect(timing("input", "bytes")).toBe("pre");
    expect(timing("input", "megapixels")).toBe("pre");
  });

  it("marks input tokens `estimated` — the one dimension reserved from a guess", () => {
    // This is why the reservation is trued up: only input tokens are guessed
    // pre-call and made exact from Bedrock's returned usage.
    expect(timing("input", "tokens")).toBe("estimated");
  });

  it("marks every OUTPUT unit and derived cost `post`", () => {
    for (const unit of ["bytes", "tokens", "megapixels", "duration_s", "frames"]) {
      expect(timing("output", unit), unit).toBe("post");
    }
    expect(timing("cost", "usd")).toBe("post");
    expect(timing("credits", "count")).toBe("post");
  });

  it("every spec carries a valid timing and source", () => {
    for (const s of DIMENSION_UNIT_SPECS) {
      expect(["pre", "estimated", "post"], `${s.dimension}:${s.unit}`).toContain(s.timing);
      expect(["cds", "app"], `${s.dimension}:${s.unit}`).toContain(s.source);
      // generic ⇔ CDS-measured is the invariant the fail-closed check rests on.
      expect(s.generic, `${s.dimension}:${s.unit}`).toBe(s.source === "cds");
    }
  });

  it("has no duplicate (dimension, unit) pairs", () => {
    const keys = DIMENSION_UNIT_SPECS.map((s) => dimensionUnitKey(s.dimension, s.unit));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// Model registry: overrides beyond pricing, and registry invariants
// ---------------------------------------------------------------------------

describe("model overrides beyond pricing", () => {
  it("overrides estimates, merging over the platform defaults", () => {
    const m = effectiveModel("anthropic.claude-haiku-4-5", [
      { modelId: "anthropic.claude-haiku-4-5", estimates: { imageTokens: 500 } },
    ])!;
    expect(m.estimates.imageTokens).toBe(500);
  });

  it("an estimates override changes the reserved image-token projection", () => {
    const m = effectiveModel("anthropic.claude-haiku-4-5", [
      { modelId: "anthropic.claude-haiku-4-5", estimates: { imageTokens: 500 } },
    ])!;
    const p = projectReservation({ model: m, ctx, imageCount: 1, maxTokens: 10 });
    expect(p.find((x) => x.dimension === "input" && x.unit === "tokens")?.quantity).toBe(500);
  });

  it("overrides vision in both directions", () => {
    expect(
      effectiveModel("anthropic.claude-haiku-4-5", [
        { modelId: "anthropic.claude-haiku-4-5", vision: false },
      ])!.vision,
    ).toBe(false);
    expect(
      effectiveModel("openai.gpt-oss-120b", [{ modelId: "openai.gpt-oss-120b", vision: true }])!
        .vision,
    ).toBe(true);
  });

  it("overrides the provider of a platform model", () => {
    const m = effectiveModel("anthropic.claude-haiku-4-5", [
      { modelId: "anthropic.claude-haiku-4-5", provider: "amazon" },
    ])!;
    expect(m.provider).toBe("amazon");
    expect(m.source).toBe("platform"); // still a platform row
  });

  it("SETS a non-null inference profile (not just clears it), changing the invoke target", () => {
    const m = effectiveModel("anthropic.claude-haiku-4-5", [
      { modelId: "anthropic.claude-haiku-4-5", inferenceProfileId: "us.custom.profile-1" },
    ])!;
    expect(m.inferenceProfileId).toBe("us.custom.profile-1");
    expect(bedrockInvokeTarget(m)).toBe("us.custom.profile-1");
  });

  it("adds an inference profile to a model that shipped without one", () => {
    const m = effectiveModel("openai.gpt-oss-120b", [
      { modelId: "openai.gpt-oss-120b", inferenceProfileId: "us.openai.gpt-oss-120b" },
    ])!;
    expect(bedrockInvokeTarget(m)).toBe("us.openai.gpt-oss-120b");
  });

  it("uses the FIRST override row when the table holds duplicates for one model", () => {
    // The store maps rows straight from DSQL; model_id is the primary key there,
    // but the pure resolver must still be deterministic if handed duplicates.
    const m = effectiveModel("anthropic.claude-haiku-4-5", [
      { modelId: "anthropic.claude-haiku-4-5", pricing: { [dimensionUnitKey("input", "tokens")]: perMTok(2) } },
      { modelId: "anthropic.claude-haiku-4-5", pricing: { [dimensionUnitKey("input", "tokens")]: perMTok(9) } },
    ])!;
    expect(m.pricing[dimensionUnitKey("input", "tokens")]).toBeCloseTo(perMTok(2));
  });

  it("ignores overrides that target a different model", () => {
    const m = effectiveModel("anthropic.claude-haiku-4-5", [
      { modelId: "anthropic.claude-sonnet-5", pricing: { [dimensionUnitKey("input", "tokens")]: perMTok(99) } },
    ])!;
    expect(m.pricing[dimensionUnitKey("input", "tokens")]).toBeCloseTo(perMTok(1));
  });

  it("merges pricing per-key rather than replacing the whole table", () => {
    const m = effectiveModel("amazon.nova-canvas-v1:0", [
      { modelId: "amazon.nova-canvas-v1:0", pricing: { [dimensionUnitKey("output", "bytes")]: 0.001 } },
    ])!;
    // The platform's per-image price survives an unrelated added key.
    expect(m.pricing[dimensionUnitKey("requests", "image")]).toBeCloseTo(0.04);
    expect(m.pricing[dimensionUnitKey("output", "bytes")]).toBeCloseTo(0.001);
  });
});

describe("platform registry invariants", () => {
  it("has unique model ids", () => {
    const ids = PLATFORM_MODEL_REGISTRY.map((m) => m.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every model id is provider-prefixed and matches its declared provider", () => {
    for (const m of PLATFORM_MODEL_REGISTRY) {
      expect(m.modelId, m.modelId).toMatch(/^[a-z0-9]+\.[a-z0-9][a-z0-9._:-]*$/);
      expect(m.modelId.split(".")[0], m.modelId).toBe(m.provider);
    }
  });

  it("every pricing key is a KNOWN dimension:unit pair (catches a typo'd rate)", () => {
    // A typo'd key silently prices nothing — deriveCostUsd just wouldn't match
    // it — so the cost gate would under-count with no error anywhere.
    for (const m of PLATFORM_MODEL_REGISTRY) {
      for (const key of Object.keys(m.defaults.pricing)) {
        const [dimension, unit] = key.split(":");
        expect(isKnownDimensionUnit(dimension!, unit!), `${m.modelId} → ${key}`).toBe(true);
      }
    }
  });

  it("every model prices at least one dimension it can actually accrue", () => {
    for (const m of PLATFORM_MODEL_REGISTRY) {
      const keys = Object.keys(m.defaults.pricing);
      expect(keys.length, m.modelId).toBeGreaterThan(0);
      expect(keys.every((k) => m.defaults.pricing[k]! > 0), m.modelId).toBe(true);
    }
  });

  it("a text model prices tokens; a generation model prices its output unit", () => {
    for (const m of PLATFORM_MODEL_REGISTRY) {
      const modality = m.outputModality ?? "text";
      const keys = Object.keys(m.defaults.pricing);
      if (modality === "text") {
        expect(keys, m.modelId).toContain(dimensionUnitKey("input", "tokens"));
        expect(keys, m.modelId).toContain(dimensionUnitKey("output", "tokens"));
      } else {
        // Generation returns no token usage, so token pricing would never fire.
        expect(keys.some((k) => k.endsWith(":tokens")), m.modelId).toBe(false);
      }
    }
  });

  it("every registry entry resolves through effectiveModel with no overrides", () => {
    for (const m of PLATFORM_MODEL_REGISTRY) {
      const eff = effectiveModel(m.modelId);
      expect(eff, m.modelId).toBeTruthy();
      expect(eff!.source).toBe("platform");
      expect(eff!.provider).toBe(m.provider);
      expect(bedrockInvokeTarget(eff!)).toBeTruthy();
    }
  });

  it("only vision models can be fed an image, and every image-token estimate belongs to one", () => {
    for (const m of PLATFORM_MODEL_REGISTRY) {
      if (m.defaults.estimates.imageTokens !== undefined) {
        expect(m.vision, m.modelId).toBe(true);
      }
    }
  });
});

describe("amazon.nova-lite (the form-free vision model in the photos manifest)", () => {
  const NOVA_LITE = effectiveModel("amazon.nova-lite")!;

  it("resolves as an amazon vision text model on a cross-region profile", () => {
    expect(NOVA_LITE.provider).toBe("amazon");
    expect(NOVA_LITE.vision).toBe(true);
    expect(NOVA_LITE.outputModality).toBe("text");
    expect(outputDelivery(NOVA_LITE.outputModality)).toBe("inline");
    expect(bedrockInvokeTarget(NOVA_LITE)).toBe("us.amazon.nova-lite-v1:0");
  });

  it("prices tokens at its own (much cheaper) rates", () => {
    expect(NOVA_LITE.pricing[dimensionUnitKey("input", "tokens")]).toBeCloseTo(perMTok(0.06));
    expect(NOVA_LITE.pricing[dimensionUnitKey("output", "tokens")]).toBeCloseTo(perMTok(0.24));
  });

  it("projects and reconciles a captioning request off its own image-token estimate", () => {
    const novaCtx: CapabilityRequestContext = {
      appId: "photos",
      provider: "amazon",
      model: "amazon.nova-lite",
      modality: "image",
    };
    const p = projectReservation({
      model: NOVA_LITE,
      ctx: novaCtx,
      inputBytes: 2048,
      imageCount: 1,
      maxTokens: 100,
    });
    const byKey = (d: string, u: string) => p.find((m) => m.dimension === d && m.unit === u)?.quantity;
    expect(byKey("input", "tokens")).toBe(1300);
    expect(byKey("cost", "usd")).toBeCloseTo(perMTok(0.06) * 1300 + perMTok(0.24) * 100);

    const r = reconcile2({
      model: NOVA_LITE,
      ctx: novaCtx,
      inputTokens: 1290,
      outputTokens: 42,
      inputBytes: 2048,
    });
    expect(r.find((m) => m.dimension === "cost")?.quantity).toBeCloseTo(
      perMTok(0.06) * 1290 + perMTok(0.24) * 42,
    );
  });
});

describe("capability registry completeness", () => {
  it("lookupCapability resolves the wired capability and nothing else", () => {
    expect(lookupCapability(CAPABILITY_BEDROCK_INVOKE)?.modelKeyed).toBe(true);
    expect(lookupCapability("bedrock.agent")).toBeUndefined();
  });

  it("every reserved name is unclaimable and none of them is wired", () => {
    for (const name of RESERVED_CAPABILITY_NAMES) {
      expect(isReservedCapabilityName(name), name).toBe(true);
      expect(isKnownCapability(name), name).toBe(false);
    }
  });

  it("the registry has unique names", () => {
    const names = CAPABILITY_REGISTRY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
