import { describe, it, expect } from "vitest";
import {
  resolveVariant,
  resolveVariants,
  parseVariantLongEdges,
  MAX_VARIANT_TARGETS,
  type VariantCandidate,
} from "../src/records/variants.js";
import { createStarkeepId } from "../src/identifiers/index.js";

/**
 * Candidates are named by their *dimensions*, never by a size class. A test
 * that said `imageMedium` would encode exactly the assumption this module
 * exists to prevent: that a class name tells you a size. It does not — classes
 * are per-record maxima, so a "2560" class holds a 900 px file when its source
 * was 900 px.
 */
function variant(id: string, width: number, height: number): VariantCandidate {
  return {
    id: createStarkeepId(id),
    objectStorageKey: `shared/image/aa/${id}`,
    type: "image/avif",
    width,
    height,
  };
}

// A plausible ladder for one landscape record, in ascending long edge.
const ladder = [
  variant("v400", 400, 300),
  variant("v1280", 1280, 960),
  variant("v2560", 2560, 1920),
];

describe("resolveVariant — rule 1: smallest at or above the target", () => {
  it("picks the exact rung when one matches", () => {
    expect(resolveVariant(ladder, 1280)?.longEdge).toBe(1280);
  });

  it("rounds up rather than down", () => {
    // 500 px of viewport must not be served a 400 px image and upscaled.
    expect(resolveVariant(ladder, 500)?.longEdge).toBe(1280);
  });

  it("picks the smallest qualifying rung, not merely a qualifying one", () => {
    // Shipping 2560 for a 401 px request is ~40× the pixels, and under
    // Intelligent-Tiering it also promotes the large object back to Frequent
    // Access for 30 days.
    expect(resolveVariant(ladder, 401)?.longEdge).toBe(1280);
  });

  it("serves the smallest rung for a tiny request", () => {
    expect(resolveVariant(ladder, 1)?.longEdge).toBe(400);
  });
});

describe("resolveVariant — rule 2: clamp to the largest that exists", () => {
  // This is what lets a client request its full viewport size without knowing
  // whether this record has a rung that large. It gets the best available and
  // can compare the returned dimensions against what it asked for.
  it("returns the largest rung when the target exceeds every rung", () => {
    expect(resolveVariant(ladder, 99999)?.longEdge).toBe(2560);
  });

  it("returns the only rung when there is one", () => {
    expect(resolveVariant([variant("only", 400, 400)], 99999)?.longEdge).toBe(400);
  });
});

describe("resolveVariant — rule 3: never the original", () => {
  // Candidates are derived children only. There is no code path here that
  // reaches a parent, and the test asserts the *absence*: exceeding the ladder
  // must be an explicit restore, never an implicit one, which is the same
  // guarantee the storage layer enforces by refusing to thaw on read.
  it("resolves to nothing when a record has no variants at all", () => {
    expect(resolveVariant([], 400)).toBeNull();
  });

  it("never returns something larger than its largest variant", () => {
    for (const target of [1, 400, 1281, 5000, 1_000_000]) {
      const resolved = resolveVariant(ladder, target);
      expect(resolved!.longEdge).toBeLessThanOrEqual(2560);
    }
  });
});

describe("resolveVariant — dimensions", () => {
  it("uses the long edge of a portrait variant, not its width", () => {
    const portrait = [variant("p", 600, 1200)];
    expect(resolveVariant(portrait, 1000)?.longEdge).toBe(1200);
    expect(resolveVariant(portrait, 1300)?.longEdge).toBe(1200);
  });

  // "Largest that exists" is meaningless over a set you cannot order, so an
  // unmeasured variant is excluded rather than guessed at.
  it("ignores variants with unknown dimensions", () => {
    const mixed = [
      { ...variant("known", 400, 300) },
      { ...variant("unknown", 0, 0), width: null, height: null },
    ];
    expect(resolveVariant(mixed, 400)?.id).toBe(createStarkeepId("known"));
  });

  it("resolves to nothing when every variant is unmeasured", () => {
    const unmeasured = [{ ...variant("a", 0, 0), width: null, height: null }];
    expect(resolveVariant(unmeasured, 400)).toBeNull();
  });

  it("ignores zero and negative dimensions, which are not measurements", () => {
    const bogus = [{ ...variant("zero", 0, 0) }, variant("real", 400, 300)];
    expect(resolveVariant(bogus, 100)?.id).toBe(createStarkeepId("real"));
  });
});

describe("resolveVariant — determinism", () => {
  // Two variants can legitimately share a long edge: a class that clamped to
  // its source, or a re-derivation mid-supersession. An unstable choice hands a
  // different URL to each request, defeating client and edge caching for
  // exactly the records that have the most variants.
  it("breaks long-edge ties stably, regardless of input order", () => {
    const a = variant("aaa", 400, 300);
    const b = variant("bbb", 400, 225);
    const forward = resolveVariant([a, b], 400)!.id;
    const backward = resolveVariant([b, a], 400)!.id;
    expect(forward).toBe(backward);
  });

  it("gives the same answer on repeated calls", () => {
    const shuffled = [ladder[2]!, ladder[0]!, ladder[1]!];
    expect(resolveVariant(shuffled, 1000)!.id).toBe(resolveVariant(ladder, 1000)!.id);
  });
});

describe("resolveVariants — several targets at once", () => {
  // Progressive presentation asks for a tile and a viewport stage together,
  // off the record list that was being fetched anyway.
  it("keys results by the requested target", () => {
    const out = resolveVariants(ladder, [400, 1280]);
    expect(Object.keys(out).sort()).toEqual(["1280", "400"]);
    expect(out["400"]!.longEdge).toBe(400);
    expect(out["1280"]!.longEdge).toBe(1280);
  });

  it("may resolve two targets to the same variant", () => {
    const out = resolveVariants(ladder, [1000, 1280]);
    expect(out["1000"]!.id).toBe(out["1280"]!.id);
  });

  it("returns an empty map when the record has no variants", () => {
    expect(resolveVariants([], [400, 1280])).toEqual({});
  });

  it("returns the actual dimensions so a client can compare what it got", () => {
    const out = resolveVariants(ladder, [99999]);
    expect(out["99999"]).toMatchObject({ width: 2560, height: 1920, longEdge: 2560 });
  });
});

describe("parseVariantLongEdges", () => {
  it("parses a comma list", () => {
    expect(parseVariantLongEdges("400,1280")).toEqual({ ok: true, targets: [400, 1280] });
  });

  it("tolerates whitespace", () => {
    expect(parseVariantLongEdges(" 400 , 1280 ")).toEqual({ ok: true, targets: [400, 1280] });
  });

  it("collapses duplicates", () => {
    expect(parseVariantLongEdges("400,400")).toEqual({ ok: true, targets: [400] });
  });

  // Rejects rather than coerces. A silently-dropped bad target serves a
  // plausible-looking wrong size, and a caller that asked in pixels precisely
  // so it would not have to reason about classes has no way to notice.
  it.each([
    ["a CSS-ish value", "400px"],
    ["trailing junk", "12abc"],
    ["a float", "400.5"],
    ["a negative", "-400"],
    ["zero", "0"],
    ["empty", ""],
    ["only separators", ",,,"],
  ])("rejects %s", (_label, raw) => {
    expect(parseVariantLongEdges(raw).ok).toBe(false);
  });

  it("caps how many sizes one request may ask for", () => {
    const tooMany = Array.from({ length: MAX_VARIANT_TARGETS + 1 }, (_, i) => 100 + i).join(",");
    const result = parseVariantLongEdges(tooMany);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/at most/);
  });

  it("allows exactly the cap", () => {
    const atCap = Array.from({ length: MAX_VARIANT_TARGETS }, (_, i) => 100 + i).join(",");
    expect(parseVariantLongEdges(atCap).ok).toBe(true);
  });
});
