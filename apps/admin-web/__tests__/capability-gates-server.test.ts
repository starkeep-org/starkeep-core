/**
 * Operator gate validation + the DSQL-row ↔ wire projection (plan §3.5).
 *
 * `shared.capability_gates` is the cost-governance table: a row here is the only
 * thing that bounds spend. Two properties are load-bearing and are what this
 * file exists to pin:
 *
 *   1. A saved gate is ENFORCEABLE. Everything the broker could not act on — an
 *      unmetered (dimension, unit), an unknown provider scope, a NaN limit, a
 *      zero-second burst window — is rejected, because a persisted-but-inert row
 *      reads as a limit in the operator's table while bounding nothing.
 *   2. Consent gates are NOT editable here. Their limit is re-upserted from the
 *      app's manifest on every reinstall, so an operator "tightening" one would
 *      silently revert. Tightening is done by ADDING a gate — gates compose and
 *      any breach denies.
 */
import { describe, it, expect } from "vitest";
import {
  DIMENSION_UNIT_SPECS,
  CAPABILITY_BEDROCK_INVOKE,
  dimensionUnitKey,
} from "@starkeep/protocol-primitives";
import {
  validateGateInput,
  rowToGateView,
  isOperatorGateId,
  newOperatorGateId,
  OPERATOR_GATE_PREFIX,
  GATE_DIMENSION_OPTIONS,
  GATE_CAPABILITY_NAMES,
  GATE_PROVIDERS,
  type GateColumns,
  type GateDbRow,
} from "../src/lib/capability-gates-server";
import {
  gateCaveat,
  describeScope,
  describeWindow,
  type GateInput,
} from "../src/lib/capability-gates";

const CAP = CAPABILITY_BEDROCK_INVOKE;

function gate(over: Partial<GateInput> = {}): GateInput {
  return {
    capabilityName: CAP,
    dimension: "cost",
    unit: "usd",
    window: { kind: "calendar", period: "month" },
    limit: 50,
    ...over,
  };
}

/** Validate and return the columns, failing the test on a rejection. */
function columnsFor(input: GateInput): GateColumns {
  const res = validateGateInput(input);
  if ("error" in res) throw new Error(`unexpected rejection: ${res.error}`);
  return res.columns;
}

/** Validate and return the error, failing the test on an acceptance. */
function errorFor(input: unknown): string {
  const res = validateGateInput(input as GateInput);
  if (!("error" in res)) throw new Error("expected a rejection");
  return res.error;
}

function dbRow(over: Partial<GateDbRow> = {}): GateDbRow {
  return {
    id: `${OPERATOR_GATE_PREFIX}01ABC`,
    capability_name: CAP,
    dimension: "cost",
    unit: "usd",
    scope_provider: null,
    scope_model: null,
    scope_app_id: null,
    window_kind: "calendar",
    window_period: "month",
    window_seconds: null,
    limit_value: 50,
    on_exceed: "deny",
    origin: "operator",
    created_at: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The catalogue the editor renders from
// ---------------------------------------------------------------------------

describe("GATE_DIMENSION_OPTIONS", () => {
  it("is exactly the platform's metered pairs, classification included", () => {
    expect(GATE_DIMENSION_OPTIONS).toHaveLength(DIMENSION_UNIT_SPECS.length);
    for (const spec of DIMENSION_UNIT_SPECS) {
      const opt = GATE_DIMENSION_OPTIONS.find(
        (o) => o.key === dimensionUnitKey(spec.dimension, spec.unit),
      )!;
      expect(opt, spec.dimension + ":" + spec.unit).toBeTruthy();
      expect(opt.source).toBe(spec.source);
      expect(opt.timing).toBe(spec.timing);
      expect(opt.generic).toBe(spec.generic);
    }
  });

  it("offers the CDS-measured spend cap the whole design rests on", () => {
    const cost = GATE_DIMENSION_OPTIONS.find((o) => o.key === "cost:usd")!;
    expect(cost.source).toBe("cds");
    expect(gateCaveat(cost)).toBeNull();
  });

  it("lists only the wired capabilities and the registry's providers", () => {
    expect(GATE_CAPABILITY_NAMES).toContain(CAP);
    expect(GATE_PROVIDERS).toContain("anthropic");
    expect(GATE_PROVIDERS).toContain("amazon");
  });
});

describe("gateCaveat", () => {
  it("is silent for CDS-measured dimensions (they are hard limits)", () => {
    for (const key of ["cost:usd", "requests:all", "input:bytes", "output:tokens"]) {
      const opt = GATE_DIMENSION_OPTIONS.find((o) => o.key === key)!;
      expect(gateCaveat(opt), key).toBeNull();
    }
  });

  it("warns that a pre-call app-reported value can be under-reported", () => {
    const opt = GATE_DIMENSION_OPTIONS.find((o) => o.key === "input:megapixels")!;
    expect(gateCaveat(opt)).toMatch(/under-report/);
  });

  it("warns that a post-call app-reported value is best-effort", () => {
    const opt = GATE_DIMENSION_OPTIONS.find((o) => o.key === "credits:count")!;
    expect(gateCaveat(opt)).toMatch(/best-effort/);
  });
});

// ---------------------------------------------------------------------------
// Gate ownership
// ---------------------------------------------------------------------------

describe("gate ownership", () => {
  it("mints operator-prefixed ids", () => {
    const id = newOperatorGateId();
    expect(isOperatorGateId(id)).toBe(true);
    expect(id.length).toBeGreaterThan(OPERATOR_GATE_PREFIX.length);
    expect(newOperatorGateId()).not.toBe(id);
  });

  it("does not claim a consent gate's id", () => {
    expect(isOperatorGateId("consent:photos:bedrock.invoke")).toBe(false);
  });

  it("assigns an id when creating and keeps it when editing", () => {
    expect(isOperatorGateId(columnsFor(gate()).id)).toBe(true);
    expect(columnsFor(gate({ id: "operator:FIXED" })).id).toBe("operator:FIXED");
  });

  it("REFUSES to write an app-consent gate", () => {
    // Its limit is re-upserted from the manifest on the app's next install, so
    // an edit here would silently revert.
    expect(errorFor(gate({ id: "consent:photos:bedrock.invoke" }))).toMatch(
      /Only operator-created gates/,
    );
  });

  it("refuses any foreign id shape, not just consent ones", () => {
    for (const id of ["gate-1", "OPERATOR:x", " consent:x"]) {
      expect(errorFor(gate({ id })), id).toMatch(/Only operator-created gates/);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation — every rejection is "the broker could not enforce this"
// ---------------------------------------------------------------------------

describe("validateGateInput — the enforceable-gate rule", () => {
  it("accepts a plain global monthly cost cap", () => {
    expect(columnsFor(gate())).toMatchObject({
      capability_name: CAP,
      dimension: "cost",
      unit: "usd",
      scope_provider: null,
      scope_model: null,
      scope_app_id: null,
      window_kind: "calendar",
      window_period: "month",
      window_seconds: null,
      limit_value: 50,
      on_exceed: "deny",
      origin: "operator",
    });
  });

  it("accepts every metered (dimension, unit) the platform ships", () => {
    for (const opt of GATE_DIMENSION_OPTIONS) {
      const cols = columnsFor(gate({ dimension: opt.dimension, unit: opt.unit }));
      expect(cols.dimension, opt.key).toBe(opt.dimension);
      expect(cols.unit, opt.key).toBe(opt.unit);
    }
  });

  it("rejects an UNMETERED pair — it would never sum and never fire", () => {
    for (const [dimension, unit] of [
      ["gpu", "seconds"],
      ["cost", "eur"],
      ["input", "widgets"],
    ]) {
      expect(errorFor(gate({ dimension, unit })), `${dimension}:${unit}`).toMatch(
        /not a metered/,
      );
    }
  });

  it("rejects a missing dimension or unit", () => {
    expect(errorFor(gate({ dimension: "" }))).toMatch(/dimension and unit required/);
    expect(errorFor(gate({ unit: "   " }))).toMatch(/dimension and unit required/);
  });

  it("rejects an unknown capability", () => {
    expect(errorFor(gate({ capabilityName: "bedrock.agent" }))).toMatch(/Unknown capability/);
    expect(errorFor(gate({ capabilityName: "" }))).toMatch(/capabilityName required/);
  });

  it("rejects a limit that cannot be compared against a SUM", () => {
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, -1, "50", null, undefined]) {
      expect(errorFor(gate({ limit: limit as number })), String(limit)).toMatch(
        /limit must be a non-negative number/,
      );
    }
  });

  it("accepts a zero limit (a hard stop is a legitimate limit)", () => {
    expect(columnsFor(gate({ limit: 0 })).limit_value).toBe(0);
  });

  it("always writes on_exceed=deny and origin=operator", () => {
    // deny-only for this increment; there is no soft-budget mode to opt into.
    const cols = columnsFor(gate({ ...({ onExceed: "notify" } as object) }));
    expect(cols.on_exceed).toBe("deny");
    expect(cols.origin).toBe("operator");
  });

  it("rejects a missing gate body outright", () => {
    expect(errorFor(undefined)).toBe("gate required");
    expect(errorFor("nope")).toBe("gate required");
  });
});

describe("validateGateInput — windows", () => {
  it("accepts both calendar periods", () => {
    expect(columnsFor(gate({ window: { kind: "calendar", period: "week" } }))).toMatchObject({
      window_kind: "calendar",
      window_period: "week",
      window_seconds: null,
    });
    expect(columnsFor(gate({ window: { kind: "calendar", period: "month" } })).window_period).toBe(
      "month",
    );
  });

  it("rejects an unknown calendar period (the broker would silently read it as month)", () => {
    expect(
      errorFor(gate({ window: { kind: "calendar", period: "day" } as never })),
    ).toMatch(/week or month/);
  });

  it("accepts a burst window and stores its seconds", () => {
    expect(columnsFor(gate({ window: { kind: "burst", seconds: 60 } }))).toMatchObject({
      window_kind: "burst",
      window_period: null,
      window_seconds: 60,
    });
  });

  it("rejects a burst window that cannot bound concurrency", () => {
    // 0 or a fraction of a second sums an empty window, so the burst gate — the
    // thing that bounds in-flight reservation overage — would never bind.
    for (const seconds of [0, -5, 1.5, Number.NaN, "60" as unknown as number]) {
      expect(errorFor(gate({ window: { kind: "burst", seconds } })), String(seconds)).toMatch(
        /positive whole number/,
      );
    }
  });

  it("rejects an unknown or missing window kind", () => {
    expect(errorFor(gate({ window: { kind: "rolling" } as never }))).toMatch(
      /calendar or burst/,
    );
    expect(errorFor(gate({ window: undefined as never }))).toBe("window required");
  });
});

describe("validateGateInput — scope", () => {
  it("stores each scope key and leaves omitted ones NULL (wildcard)", () => {
    expect(
      columnsFor(gate({ scope: { provider: "anthropic", model: "anthropic.claude-haiku-4-5", appId: "photos" } })),
    ).toMatchObject({
      scope_provider: "anthropic",
      scope_model: "anthropic.claude-haiku-4-5",
      scope_app_id: "photos",
    });
  });

  it("treats an empty/whitespace scope field as a wildcard, not a literal match", () => {
    const cols = columnsFor(gate({ scope: { model: "   ", appId: "" } }));
    expect(cols.scope_model).toBeNull();
    expect(cols.scope_app_id).toBeNull();
  });

  it("trims a scope value so a stray space can't make the gate un-matchable", () => {
    expect(columnsFor(gate({ scope: { appId: " photos " } })).scope_app_id).toBe("photos");
  });

  it("rejects a provider the registry doesn't know — it would match nothing", () => {
    expect(errorFor(gate({ scope: { provider: "acme" } }))).toMatch(/Unknown provider/);
  });

  it("accepts every provider the registry does know", () => {
    for (const provider of GATE_PROVIDERS) {
      expect(columnsFor(gate({ scope: { provider } })).scope_provider, provider).toBe(provider);
    }
  });

  it("does NOT constrain the model id (operator-defined models are legal targets)", () => {
    expect(columnsFor(gate({ scope: { model: "acme.custom-1" } })).scope_model).toBe(
      "acme.custom-1",
    );
  });
});

// ---------------------------------------------------------------------------
// rowToGateView — must agree with the broker's own row → Gate defaults
// ---------------------------------------------------------------------------

describe("rowToGateView", () => {
  it("projects a plain operator gate", () => {
    expect(rowToGateView(dbRow())).toEqual({
      id: `${OPERATOR_GATE_PREFIX}01ABC`,
      capabilityName: CAP,
      dimension: "cost",
      unit: "usd",
      scope: {},
      window: { kind: "calendar", period: "month" },
      limit: 50,
      origin: "operator",
      editable: true,
      createdAt: null,
    });
  });

  it("marks an app-consent gate read-only", () => {
    const view = rowToGateView(
      dbRow({ id: "consent:photos:bedrock.invoke", origin: "app-consent", scope_app_id: "photos" }),
    );
    expect(view.editable).toBe(false);
    expect(view.origin).toBe("app-consent");
    expect(view.scope).toEqual({ appId: "photos" });
  });

  it("coerces DSQL's string numerics (limit and burst seconds come back as text)", () => {
    const view = rowToGateView(
      dbRow({ limit_value: "20.5", window_kind: "burst", window_seconds: "60" }),
    );
    expect(view.limit).toBe(20.5);
    expect(view.window).toEqual({ kind: "burst", seconds: 60 });
  });

  it("defaults a null burst window to 0 seconds and a null period to month", () => {
    // Matches the broker's rowToGate — the operator must see the limit that is
    // actually enforced, not a prettier one.
    expect(rowToGateView(dbRow({ window_kind: "burst", window_seconds: null })).window).toEqual({
      kind: "burst",
      seconds: 0,
    });
    expect(rowToGateView(dbRow({ window_period: null })).window).toEqual({
      kind: "calendar",
      period: "month",
    });
  });

  it("reads an unrecognized window_kind as calendar, like the broker does", () => {
    expect(rowToGateView(dbRow({ window_kind: "rolling" })).window).toEqual({
      kind: "calendar",
      period: "month",
    });
  });

  it("drops empty scope columns to wildcards rather than matching the empty string", () => {
    const view = rowToGateView(dbRow({ scope_provider: "", scope_model: null, scope_app_id: "" }));
    expect(view.scope).toEqual({});
  });

  it("serializes created_at whether it arrives as a Date or a string", () => {
    const d = new Date("2026-07-25T00:00:00.000Z");
    expect(rowToGateView(dbRow({ created_at: d })).createdAt).toBe(d.toISOString());
    expect(rowToGateView(dbRow({ created_at: "2026-07-25" })).createdAt).toBe("2026-07-25");
  });

  it("round-trips a validated gate back through the row shape", () => {
    const cols = columnsFor(
      gate({
        dimension: "requests",
        unit: "all",
        scope: { provider: "amazon", appId: "photos" },
        window: { kind: "burst", seconds: 30 },
        limit: 100,
      }),
    );
    const view = rowToGateView({ ...cols, created_at: null });
    expect(view).toMatchObject({
      capabilityName: CAP,
      dimension: "requests",
      unit: "all",
      scope: { provider: "amazon", appId: "photos" },
      window: { kind: "burst", seconds: 30 },
      limit: 100,
      editable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Table summaries
// ---------------------------------------------------------------------------

describe("describeScope / describeWindow", () => {
  it("reads an all-wildcard scope as global", () => {
    expect(describeScope({})).toBe("global");
  });

  it("names every set scope key", () => {
    expect(describeScope({ appId: "photos", provider: "anthropic", model: "m" })).toBe(
      "app photos · provider anthropic · model m",
    );
    expect(describeScope({ provider: "amazon" })).toBe("provider amazon");
  });

  it("distinguishes the two window kinds", () => {
    expect(describeWindow({ kind: "calendar", period: "month" })).toBe("per month");
    expect(describeWindow({ kind: "burst", seconds: 60 })).toBe("60s burst");
  });
});
