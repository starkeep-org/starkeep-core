/**
 * The metering-dimension model for the cloud capability broker (see
 * plan-cloud-capability-broker-bedrock, §3.5).
 *
 * A usage gate meters one `(dimension, unit)` pair. The set is deliberately
 * **open** — AI services bill on genuinely different well-defined units and new
 * ones arrive on the provider's cadence, not the platform's — so nothing here is
 * a closed enum the schema hardcodes. This module is the single home for:
 *
 *   - which `(dimension, unit)` pairs the wired `bedrock.invoke` capability
 *     understands,
 *   - the two orthogonal axes that decide enforcement and UI caveating:
 *       * TIMING — when the quantity is knowable (pre-call exact / estimated
 *         pre-call / post-call), and
 *       * SOURCE — who measures it (CDS-measured = trustworthy against a hostile
 *         app; app-reported = only as trustworthy as the app), and
 *   - which dimensions are GENERIC (CDS-measured, never declared by an app) vs
 *     NON-GENERIC (app-reported, and therefore must be declared in the app's
 *     manifest `reports[]` or a matching limit fails closed).
 *
 * Pure and store-agnostic. The security-critical property this encodes: the
 * load-bearing spend cap rests entirely on the CDS-measured set — a malicious
 * app cannot under-report any of it.
 */

/** The metering dimensions the broker understands. Open by convention: the
 * gate row stores free strings, but these are the ones with defined semantics. */
export type Dimension = "requests" | "input" | "output" | "credits" | "cost";

/**
 * How trustworthy a measurement is:
 *   - "cds"  — measured directly by the CDS (request count, S3 object size,
 *              Bedrock-returned token usage, derived cost). Holds against a
 *              hostile app.
 *   - "app"  — supplied by the app (megapixels, pages, frames, the modality
 *              classification of a request, …). Only as trustworthy as the app;
 *              an operator cost-shaping convenience, never a boundary.
 */
export type MeasurementSource = "cds" | "app";

/**
 * When the quantity is knowable:
 *   - "pre"       — exact before the call (request count, input byte size).
 *   - "estimated" — estimated before, exact after (input tokens: estimate to
 *                   reserve, reconcile from Bedrock's returned count).
 *   - "post"      — only known after / during generation (output tokens/bytes,
 *                   derived cost, output megapixels/duration).
 */
export type Timing = "pre" | "estimated" | "post";

export interface DimensionUnitSpec {
  dimension: Dimension;
  unit: string;
  source: MeasurementSource;
  timing: Timing;
  /**
   * Non-generic dimensions are app-reported and must be declared in the app's
   * manifest `reports[]`; a limit on an undeclared non-generic dimension fails
   * closed. Generic dimensions (`requests`, `input`/`output` `bytes`, `cost`)
   * are CDS-measured and are never declared.
   */
  generic: boolean;
}

// The `input` and `output` dimensions share a unit set. `bytes`/`tokens` are
// CDS-measured; the type-specific quantities are app-reported (the CDS stays
// type-agnostic and won't parse file internals).
const IO_UNITS: ReadonlyArray<{ unit: string; source: MeasurementSource }> = [
  { unit: "bytes", source: "cds" },
  { unit: "tokens", source: "cds" },
  { unit: "characters", source: "app" },
  { unit: "pages", source: "app" },
  { unit: "frames", source: "app" },
  { unit: "megapixels", source: "app" },
  { unit: "tiles", source: "app" },
  { unit: "duration_s", source: "app" },
  { unit: "megapixel_seconds", source: "app" },
];

function ioSpec(dimension: "input" | "output"): DimensionUnitSpec[] {
  return IO_UNITS.map(({ unit, source }) => {
    // input timing: bytes are exact pre-call; tokens are estimated pre-call and
    // exact post-call; app-reported input quantities are supplied (knowable)
    // pre-call. output is post-call for every unit.
    let timing: Timing;
    if (dimension === "output") {
      timing = "post";
    } else if (unit === "tokens") {
      timing = "estimated";
    } else {
      timing = "pre";
    }
    return {
      dimension,
      unit,
      source,
      timing,
      // generic = CDS-measured bytes/tokens; app-reported quantities are
      // non-generic and must be declared.
      generic: source === "cds",
    };
  });
}

/**
 * Every `(dimension, unit)` the wired `bedrock.invoke` capability meters, with
 * its source/timing/generic classification. Consulted by:
 *   - manifest validation (which units may appear in `reports[]`),
 *   - the gate table (which `(dimension, unit)` a limit may target),
 *   - the broker's fail-closed check (undeclared non-generic → deny).
 */
export const DIMENSION_UNIT_SPECS: readonly DimensionUnitSpec[] = [
  // requests: `all` is a pure CDS-measured count; the modality units require the
  // app's classification of the request and are therefore app-reported.
  { dimension: "requests", unit: "all", source: "cds", timing: "pre", generic: true },
  { dimension: "requests", unit: "text", source: "app", timing: "pre", generic: false },
  { dimension: "requests", unit: "image", source: "app", timing: "pre", generic: false },
  { dimension: "requests", unit: "audio", source: "app", timing: "pre", generic: false },
  { dimension: "requests", unit: "video", source: "app", timing: "pre", generic: false },
  ...ioSpec("input"),
  ...ioSpec("output"),
  // credits: generic model-defined units, but the count is app-reported (only
  // the model/app knows how many credits a call consumed) → non-generic.
  { dimension: "credits", unit: "count", source: "app", timing: "post", generic: false },
  // cost: always derived by the CDS from usage × the price table.
  { dimension: "cost", unit: "usd", source: "cds", timing: "post", generic: true },
];

const SPEC_BY_KEY = new Map<string, DimensionUnitSpec>(
  DIMENSION_UNIT_SPECS.map((s) => [dimensionUnitKey(s.dimension, s.unit), s]),
);

/** Canonical `"dimension:unit"` key used across the gate/ledger/reports code. */
export function dimensionUnitKey(dimension: string, unit: string): string {
  return `${dimension}:${unit}`;
}

/** Look up the spec for a `(dimension, unit)`; undefined if unknown to the
 * platform (the gate table may still store it, but the broker treats an unknown
 * pair as unmeasurable). */
export function lookupDimensionUnit(
  dimension: string,
  unit: string,
): DimensionUnitSpec | undefined {
  return SPEC_BY_KEY.get(dimensionUnitKey(dimension, unit));
}

/** True if `(dimension, unit)` is a known platform pair. */
export function isKnownDimensionUnit(dimension: string, unit: string): boolean {
  return SPEC_BY_KEY.has(dimensionUnitKey(dimension, unit));
}

/** True if `(dimension, unit)` is CDS-measured (trustworthy against a hostile
 * app). The spend cap rests on this set. */
export function isCdsMeasured(dimension: string, unit: string): boolean {
  return lookupDimensionUnit(dimension, unit)?.source === "cds";
}

/**
 * True if `(dimension, unit)` is a non-generic (app-reported) pair an app must
 * declare in its manifest `reports[]`. Generic pairs (and unknown pairs) return
 * false — unknown pairs are handled separately by manifest validation.
 */
export function isNonGenericDimensionUnit(dimension: string, unit: string): boolean {
  return lookupDimensionUnit(dimension, unit)?.generic === false;
}

/** The set of `"dimension:unit"` keys an app may legally list in `reports[]`
 * (every non-generic pair). Generic pairs are CDS-measured and never declared. */
export const REPORTABLE_DIMENSION_UNITS: readonly string[] = DIMENSION_UNIT_SPECS
  .filter((s) => !s.generic)
  .map((s) => dimensionUnitKey(s.dimension, s.unit));
