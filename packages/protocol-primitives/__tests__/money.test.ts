import { describe, it, expect } from "vitest";
import {
  MICROS_PER_USD,
  CURRENCY,
  COST_DIMENSION,
  COST_UNIT,
  isMicros,
  assertMicros,
  assertQuantity,
  isQuantity,
  assertRate,
  usdPerMTokToMicrosPerToken,
  usdPerUnitToMicrosPerUnit,
  usdDecimalToMicros,
  lineCostMicros,
  deriveCostMicros,
  formatMicrosAsUsd,
  formatRatePerMTok,
  formatRatePerUnit,
  type Micros,
  type MicrosPerUnit,
} from "../src/index.js";

const rate = (n: number) => assertRate(n);
const micros = (n: number) => assertMicros(n);

describe("money: constants", () => {
  it("denominates in millionths of the major unit", () => {
    expect(MICROS_PER_USD).toBe(1_000_000);
    expect(CURRENCY).toBe("usd");
  });

  it("names the cost unit after its canonical representation", () => {
    // A ledger row must be self-describing: `cost`/`usd_micros` quantity 102 is
    // unambiguously 102 micros, never 102 dollars.
    expect(COST_DIMENSION).toBe("cost");
    expect(COST_UNIT).toBe("usd_micros");
  });
});

describe("money: validation guards", () => {
  it("accepts non-negative integers as money", () => {
    expect(isMicros(0)).toBe(true);
    expect(isMicros(102)).toBe(true);
    expect(isMicros(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rejects every non-integer, negative, or non-finite money value", () => {
    for (const bad of [0.5, -1, NaN, Infinity, -Infinity, 2 ** 53, "1" as never, null as never]) {
      expect(isMicros(bad)).toBe(false);
      expect(() => assertMicros(bad as number)).toThrow(RangeError);
    }
  });

  it("rejects NaN quantities, the fail-open case", () => {
    // A NaN quantity would poison the window SUM, and `NaN > limit` is false —
    // the gate would then allow every request. It must be unrepresentable.
    expect(NaN > 5).toBe(false); // the hazard being guarded against
    expect(() => assertQuantity(NaN)).toThrow(RangeError);
    expect(() => assertQuantity(Infinity)).toThrow(RangeError);
    expect(() => assertQuantity(-1)).toThrow(RangeError);
    expect(() => assertQuantity(1.5)).toThrow(RangeError);
    expect(assertQuantity(0)).toBe(0);
    expect(assertQuantity(1287)).toBe(1287);
  });

  it("keeps isQuantity and assertQuantity in exact agreement", () => {
    // If the predicate accepted something the assert rejects, the broker's
    // report FILTER would pass a value that later throws inside cost derivation
    // — turning an ignorable junk report into a 500.
    for (const v of [0, 1, 1287, 2 ** 53 - 1, -1, 1.5, NaN, Infinity, -Infinity, "3", null, undefined, {}]) {
      const predicateSaysOk = isQuantity(v);
      let assertSaysOk = true;
      try {
        assertQuantity(v as number);
      } catch {
        assertSaysOk = false;
      }
      expect(predicateSaysOk).toBe(assertSaysOk);
    }
  });

  it("rejects a negative quantity, which would credit spend back", () => {
    expect(isQuantity(-5)).toBe(false);
    expect(() => assertQuantity(-5)).toThrow(RangeError);
  });

  it("allows fractional rates but not broken ones", () => {
    expect(assertRate(0.06)).toBe(0.06);
    expect(assertRate(0)).toBe(0);
    for (const bad of [NaN, Infinity, -0.01]) {
      expect(() => assertRate(bad)).toThrow(RangeError);
    }
  });

  it("includes the field name in the error so a failure is locatable", () => {
    expect(() => assertMicros(1.5, "monthly budget")).toThrow(/monthly budget/);
    expect(() => assertQuantity(NaN, "input tokens")).toThrow(/input tokens/);
  });
});

describe("money: ingest from external sources", () => {
  it("treats $/MTok as micros/token — the identity", () => {
    // $x per MTok === x micros per token. Verified against every published rate
    // in the platform registry, so the registry can be authored with the
    // provider's own printed numbers.
    for (const usdPerMTok of [0.06, 0.24, 0.15, 0.6, 0.2, 0.85, 1, 2.2, 2.5, 3, 5, 15, 25]) {
      const r = usdPerMTokToMicrosPerToken(usdPerMTok);
      expect(r).toBe(usdPerMTok);
      // The identity, derived independently: cost of 1e6 tokens is $usdPerMTok.
      expect(lineCostMicros(1_000_000, r)).toBe(usdPerMTok * MICROS_PER_USD);
    }
  });

  it("converts a per-unit price to micros per unit", () => {
    expect(usdPerUnitToMicrosPerUnit(0.04)).toBe(40_000); // $0.04 per image
    expect(usdPerUnitToMicrosPerUnit(0.08)).toBe(80_000); // $0.08 per second
  });

  it("parses decimal amounts exactly, without a float multiply", () => {
    expect(usdDecimalToMicros("0")).toBe(0);
    expect(usdDecimalToMicros("1")).toBe(1_000_000);
    expect(usdDecimalToMicros("10.20")).toBe(10_200_000);
    expect(usdDecimalToMicros("0.000001")).toBe(1);
    expect(usdDecimalToMicros("1234.567891")).toBe(1_234_567_891);
  });

  it("does not inherit the rounding error of a float multiply", () => {
    // $4.03 is the case that breaks the naive implementation: 4.03 * 1e6 is
    // 4030000.0000000005, so `Math.ceil` of the float multiply over-charges by
    // a micro. Ceiling is not enough on its own — the parse itself must be exact.
    expect(4.03 * 1e6).toBe(4_030_000.0000000005);
    expect(Math.ceil(4.03 * 1e6)).toBe(4_030_001); // the bug being avoided
    expect(usdDecimalToMicros("4.03")).toBe(4_030_000);

    // And the mirror case, where the float multiply lands just BELOW the true
    // value, so a truncating implementation would silently lose a micro.
    expect(2.01 * 1e6).toBe(2_009_999.9999999998);
    expect(Math.trunc(2.01 * 1e6)).toBe(2_009_999); // the bug being avoided
    expect(usdDecimalToMicros("2.01")).toBe(2_010_000);
  });

  it("rounds sub-micro amounts UP so spend is never under-counted", () => {
    expect(usdDecimalToMicros("0.0000005")).toBe(1);
    expect(usdDecimalToMicros("0.00000001")).toBe(1);
    expect(usdDecimalToMicros("1.0000004")).toBe(1_000_001);
    // exact micro boundaries do not gain a spurious unit
    expect(usdDecimalToMicros("0.000002")).toBe(2);
  });

  it("accepts numbers and exponent notation", () => {
    expect(usdDecimalToMicros(5)).toBe(5_000_000);
    expect(usdDecimalToMicros(10.2)).toBe(10_200_000);
    expect(usdDecimalToMicros("1e-6")).toBe(1);
    expect(usdDecimalToMicros("1.5e2")).toBe(150_000_000);
    expect(usdDecimalToMicros(1e-7)).toBe(1); // String(1e-7) === "1e-7", ceils up
  });

  it("rejects malformed, negative, and unrepresentable amounts", () => {
    for (const bad of ["", " ", "abc", "$5", "1.2.3", "--1", "1,000"]) {
      expect(() => usdDecimalToMicros(bad)).toThrow(RangeError);
    }
    expect(() => usdDecimalToMicros("-1")).toThrow(/negative/);
    expect(() => usdDecimalToMicros("-0.5")).toThrow(/negative/);
    expect(() => usdDecimalToMicros("1e20")).toThrow(/too large/);
    expect(() => usdDecimalToMicros(NaN)).toThrow(RangeError);
  });

  it("round-trips ingest through display without drift", () => {
    for (const s of ["0.000001", "0.07", "5", "10.20", "1234.567891"]) {
      const m = usdDecimalToMicros(s);
      expect(usdDecimalToMicros(formatMicrosAsUsd(m).slice(1).replace(/,/g, ""))).toBe(m);
    }
  });
});

describe("money: line cost", () => {
  it("computes ceil(quantity x rate) and always yields an integer", () => {
    expect(lineCostMicros(1287, rate(0.06))).toBe(78); // 77.22 -> 78
    expect(lineCostMicros(103, rate(0.24))).toBe(25); // 24.72 -> 25
    expect(lineCostMicros(1300, rate(0.06))).toBe(78); // exactly 78
    expect(lineCostMicros(12_192_768, rate(0.001))).toBe(12_193); // pixels
    expect(lineCostMicros(6000, rate(80))).toBe(480_000); // 6000ms @ $0.08/s
    expect(lineCostMicros(1, rate(40_000))).toBe(40_000); // one image @ $0.04
  });

  it("rounds up, never down", () => {
    expect(lineCostMicros(13, rate(0.06))).toBe(1); // 0.78 -> 1, never 0
    expect(lineCostMicros(1, rate(0.06))).toBe(1); // 0.06 -> 1
  });

  it("bounds the ceil error at one micro per line item", () => {
    for (const [qty, r] of [[13, 0.06], [1287, 0.06], [103, 0.24], [50_000, 0.06]] as const) {
      const exact = qty * r;
      const charged = lineCostMicros(qty, rate(r));
      expect(charged - exact).toBeGreaterThanOrEqual(0);
      expect(charged - exact).toBeLessThan(1);
    }
  });

  it("is zero-cost for zero quantity or zero rate", () => {
    expect(lineCostMicros(0, rate(25))).toBe(0);
    expect(lineCostMicros(1000, rate(0))).toBe(0);
  });

  it("is monotone non-decreasing in quantity", () => {
    // The property the reserve/reconcile cycle rests on: a reconciled cost can
    // never exceed a reservation whose projected quantities bounded the actuals.
    const r = rate(0.24);
    let prev = 0;
    for (let q = 0; q < 3000; q += 7) {
      const c = lineCostMicros(q, r);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it("rejects a quantity that is not a canonical integer", () => {
    expect(() => lineCostMicros(1.5, rate(1))).toThrow(RangeError);
    expect(() => lineCostMicros(NaN, rate(1))).toThrow(RangeError);
    expect(() => lineCostMicros(-1, rate(1))).toThrow(RangeError);
  });

  it("throws rather than silently losing precision on an absurd rate", () => {
    // The binding constraint is the intermediate product, which trips around
    // $9,007 for a single line item — a misconfigured rate, not real spend.
    expect(() => lineCostMicros(1_000_000, rate(1e12))).toThrow(/price table/);
    // The worst realistic line (1M output tokens of Opus at $25/MTok) is fine.
    expect(lineCostMicros(1_000_000, rate(25))).toBe(25_000_000);
  });
});

describe("money: deriveCostMicros", () => {
  const pricing: Record<string, MicrosPerUnit> = {
    "input:tokens": rate(0.06),
    "output:tokens": rate(0.24),
  };

  it("sums per-line ceilings over priced measurements", () => {
    const total = deriveCostMicros(pricing, [
      { dimension: "input", unit: "tokens", quantity: 1287 },
      { dimension: "output", unit: "tokens", quantity: 103 },
    ]);
    expect(total).toBe(78 + 25);
    expect(Number.isSafeInteger(total)).toBe(true);
  });

  it("ignores unpriced measurements", () => {
    expect(
      deriveCostMicros(pricing, [
        { dimension: "requests", unit: "all", quantity: 1 },
        { dimension: "input", unit: "bytes", quantity: 999_999 },
        { dimension: "input", unit: "tokens", quantity: 1300 },
      ]),
    ).toBe(78);
  });

  it("never prices the cost dimension itself", () => {
    // Cost is derived; letting it be priced would let a measurement set price
    // its own output.
    const selfPricing = { ...pricing, [`${COST_DIMENSION}:${COST_UNIT}`]: rate(1) };
    expect(
      deriveCostMicros(selfPricing, [
        { dimension: "input", unit: "tokens", quantity: 1300 },
        { dimension: COST_DIMENSION, unit: COST_UNIT, quantity: 78 },
      ]),
    ).toBe(78);
  });

  it("is zero for an empty or wholly unpriced set", () => {
    expect(deriveCostMicros(pricing, [])).toBe(0);
    expect(deriveCostMicros({}, [{ dimension: "input", unit: "tokens", quantity: 5 }])).toBe(0);
  });

  it("matches the real Nova Lite caption workload within a cent per 100k", () => {
    // Regression guard on the resolution argument that chose micros: a realistic
    // caption is ~102 micros and the scheme must not inflate it materially.
    const perRequest = deriveCostMicros(pricing, [
      { dimension: "input", unit: "tokens", quantity: 1300 },
      { dimension: "output", unit: "tokens", quantity: 100 },
    ]);
    expect(perRequest).toBe(102); // exact: 78 + 24, no ceil loss at all
    expect(formatMicrosAsUsd((perRequest * 100_000) as Micros)).toBe("$10.20");
  });

  it("propagates a bad quantity instead of producing a bad total", () => {
    expect(() =>
      deriveCostMicros(pricing, [{ dimension: "input", unit: "tokens", quantity: NaN }]),
    ).toThrow(RangeError);
  });
});

describe("money: display formatting", () => {
  it("formats by integer arithmetic, showing exactly the digits stored", () => {
    expect(formatMicrosAsUsd(micros(0))).toBe("$0.00");
    expect(formatMicrosAsUsd(micros(10_200_000))).toBe("$10.20");
    expect(formatMicrosAsUsd(micros(5_000_000))).toBe("$5.00");
    expect(formatMicrosAsUsd(micros(1_234_567_891))).toBe("$1,234.567891");
  });

  it("keeps sub-cent amounts visible instead of rounding them to zero", () => {
    expect(formatMicrosAsUsd(micros(102))).toBe("$0.000102");
    expect(formatMicrosAsUsd(micros(1))).toBe("$0.000001");
  });

  it("honours minDecimals and the symbol", () => {
    expect(formatMicrosAsUsd(micros(10_200_000), { minDecimals: 0 })).toBe("$10.2");
    expect(formatMicrosAsUsd(micros(5_000_000), { minDecimals: 0 })).toBe("$5");
    expect(formatMicrosAsUsd(micros(102), { symbol: "USD " })).toBe("USD 0.000102");
  });

  it("groups thousands", () => {
    expect(formatMicrosAsUsd(micros(1_000_000_000))).toBe("$1,000.00");
    expect(formatMicrosAsUsd(micros(9_007_199_254_740_991))).toMatch(/^\$9,007,199,254\./);
  });

  it("refuses to format a non-canonical value", () => {
    expect(() => formatMicrosAsUsd(10.5 as Micros)).toThrow(RangeError);
    expect(() => formatMicrosAsUsd(NaN as Micros)).toThrow(RangeError);
  });

  it("renders rates in the conventions providers publish", () => {
    expect(formatRatePerMTok(rate(3))).toBe("$3/MTok");
    expect(formatRatePerMTok(rate(0.06))).toBe("$0.06/MTok");
    expect(formatRatePerUnit(rate(40_000), "image")).toBe("$0.04/image");
    expect(formatRatePerUnit(rate(80), "ms")).toBe("$0.00008/ms");
  });
});
