/**
 * THE single home for currency representation and for every unit conversion
 * that touches money or a metered quantity. Nothing else in the codebase may
 * convert units of money, and nothing else may define what a stored number
 * means.
 *
 * ---------------------------------------------------------------------------
 * THE CANONICAL UNITS
 * ---------------------------------------------------------------------------
 *
 * There is exactly ONE set of internal units, used everywhere — in memory, on
 * the wire, and in the database:
 *
 *   MONEY       integer {@link Micros} — millionths of the major currency unit
 *               (1 USD = 1_000_000 micros). Never dollars, never cents.
 *   QUANTITIES  integer counts in the FINEST natural unit of the thing being
 *               metered: tokens, bytes, requests, pixels, frames, characters,
 *               pages, tiles, milliseconds, pixel-frames. Never kTok/MTok,
 *               never megapixels, never seconds.
 *   RATES       {@link MicrosPerUnit} — micros of currency per ONE canonical
 *               quantity unit.
 *
 * Two — and only two — places may use other units:
 *
 *   1. READING FROM AN EXTERNAL SOURCE. A provider's published price table
 *      quotes $/MTok; AWS's Cost & Usage Report quotes decimal USD. Such a
 *      value is converted to canonical units IMMEDIATELY at the point of
 *      ingest, by a function in this module, and the foreign-unit value is
 *      never stored or passed on. See {@link usdPerMTokToMicrosPerToken} and
 *      {@link usdDecimalToMicros}.
 *
 *   2. DISPLAYING TO A USER. A UI may render micros as "$10.20" or a rate as
 *      "$3.00/MTok". Display units exist only in the string handed to the
 *      renderer — never in a variable, a prop, a wire field, or a column. See
 *      {@link formatMicrosAsUsd} and {@link formatRatePerMTok}.
 *
 * ---------------------------------------------------------------------------
 * WHY MICROS, AND WHY INTEGERS
 * ---------------------------------------------------------------------------
 *
 * Money is summed across every ledger row in a window to enforce a spend cap,
 * so its representation must be exact and its failure modes must be loud. An
 * integer count of micros gives both: `SUM` is exact, and every ingress can
 * assert `Number.isSafeInteger`. A float would instead admit `NaN`, and `NaN >
 * limit` is `false` — a silent FAIL-OPEN on the security-critical control.
 *
 * Resolution: 1 micro = $0.000001. Rounding is always UP ({@link Math.ceil}),
 * applied per line item, so the ledger can never under-count spend. The error
 * is at most 1 micro per priced measurement — for a realistic request (a Nova
 * Lite caption at ~102 micros) that is under 1%, and in absolute terms a
 * million requests can over-report by at most about $2.
 *
 * Headroom: 2^53 micros is ~$9.0 billion, so a stored value or a window sum can
 * never realistically overflow. The binding constraint is instead the
 * INTERMEDIATE PRODUCT `quantity × rate` inside {@link lineCostMicros}, which
 * is ~10^6 larger than the resulting cost and so loses precision once a single
 * line item exceeds roughly $9,007. That is far outside any real invocation
 * (the worst realistic line — a million output tokens of Opus — leaves a 360×
 * margin), but it is asserted rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * WHY RATES ARE THE ONE NON-INTEGER
 * ---------------------------------------------------------------------------
 *
 * A rate is the single deliberate exception to "integers everywhere", because
 * $0.06/MTok simply IS 0.06 micros per token and no integer can express it
 * without reintroducing a per-key scale divisor. That is safe, and it is safe
 * for reasons that do not apply to money or quantities:
 *
 *   - a rate is CONFIGURATION: set once, read many, never accumulated, so
 *     representation error cannot compound;
 *   - it is consumed in exactly ONE multiply, whose `ceil` absorbs the error
 *     into the ≤1-micro bound the scheme already tolerates;
 *   - the output of that multiply is asserted to be an exact integer, so a bad
 *     rate cannot leak a non-integer into money.
 *
 * It also buys a genuinely useful identity — see
 * {@link usdPerMTokToMicrosPerToken}.
 */

/**
 * An integer count of millionths of the major currency unit. The ONLY internal
 * representation of an amount of money.
 *
 * Branded so that a raw dollar float cannot be passed where money is expected:
 * a `Micros` can only be produced by this module's constructors, which validate.
 */
export type Micros = number & { readonly __brand: "usd_micros" };

/**
 * A price: micros of currency per ONE canonical quantity unit (per token, per
 * byte, per pixel, per millisecond, per request, …). May be fractional — see
 * the module doc on why rates are the one deliberate exception to integers.
 */
export type MicrosPerUnit = number & { readonly __brand: "micros_per_unit" };

/** Micros in one major currency unit. Part of the persisted format: changing it
 * silently reinterprets every stored amount, so it is a migration, not a knob. */
export const MICROS_PER_USD = 1_000_000;

/**
 * The major currency unit everything is denominated in. Display-only: it labels
 * formatted output and documents what the price tables mean.
 *
 * It is deliberately NOT a column on the ledger or the gate table. Bedrock bills
 * in USD, so the price tables are USD-denominated by construction, and a
 * per-row currency would imply that the gate `SUM` compares amounts across
 * currencies — something that must never happen. There is no FX anywhere, and
 * no mixed-currency arithmetic is possible.
 */
export const CURRENCY = "usd";

/** The `(dimension, unit)` pair under which derived cost is metered. The unit
 * names the canonical representation so a row is self-describing: a
 * `cost`/`usd_micros` row with quantity 102 is 102 micros, i.e. $0.000102. */
export const COST_DIMENSION = "cost";
export const COST_UNIT = "usd_micros";

// ---------------------------------------------------------------------------
// Validation — the ingress guards
// ---------------------------------------------------------------------------

/** True if `n` is a valid amount of money: a non-negative exact integer. */
export function isMicros(n: unknown): n is Micros {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Assert that `n` is a valid amount of money and brand it.
 *
 * Throws rather than coercing. This is a spend-tracking system: a value that
 * cannot be represented must fail closed and loudly, never round quietly.
 */
export function assertMicros(n: number, what = "amount"): Micros {
  if (!isMicros(n)) {
    throw new RangeError(
      `${what} must be a non-negative integer number of micros (got ${n})`,
    );
  }
  return n;
}

/**
 * True if `value` is a valid metered quantity: a non-negative exact integer in
 * the canonical unit for its dimension.
 *
 * The predicate form of {@link assertQuantity}, for callers that must FILTER
 * untrusted input rather than fail on it — the broker ignores a junk app report
 * instead of erroring the request. Sharing one definition is the point: if a
 * filter accepted something the assert rejects, the assert would fire deep in
 * cost derivation and turn an ignorable bad report into a 500.
 */
export function isQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Assert that `n` is a valid metered quantity: a non-negative exact integer in
 * the canonical (finest) unit for its dimension.
 *
 * Every quantity entering the ledger or a gate comparison passes through here.
 * The `NaN` case is the one that matters: an unvalidated `NaN` quantity poisons
 * the window `SUM`, and because `NaN > limit` is `false` the gate would then
 * ALLOW every request. Rejecting at ingress makes that unrepresentable.
 */
export function assertQuantity(n: number, what = "quantity"): number {
  if (!isQuantity(n)) {
    throw new RangeError(
      `${what} must be a non-negative integer in its canonical unit (got ${n})`,
    );
  }
  return n;
}

/** Assert that `n` is a usable rate: finite and non-negative. Fractional is
 * allowed (and expected) — see the module doc. */
export function assertRate(n: number, what = "rate"): MicrosPerUnit {
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(
      `${what} must be a finite non-negative number of micros per unit (got ${n})`,
    );
  }
  return n as MicrosPerUnit;
}

// ---------------------------------------------------------------------------
// Ingest from external sources (canonical-units exception 1)
// ---------------------------------------------------------------------------

/**
 * Convert a provider's published `$/MTok` figure to the canonical rate.
 *
 * The conversion is the IDENTITY, and that is not a coincidence worth hiding:
 *
 *     $x per 1e6 tokens
 *   = x × 1e-6 dollars per token
 *   = x × 1e-6 × 1e6 micros per token
 *   = x micros per token
 *
 * So a platform price table may be authored with the published numbers exactly
 * as the provider prints them — `{ "input:tokens": 3 }` is both "$3/MTok" and
 * "3 micros/token" — with no conversion step to get wrong and no separate
 * display encoding to round-trip. This function exists to name that identity,
 * to validate, and to be the one documented ingest point.
 */
export function usdPerMTokToMicrosPerToken(usdPerMTok: number): MicrosPerUnit {
  return assertRate(usdPerMTok, "$/MTok rate");
}

/** Convert a price quoted in whole currency units per ONE canonical quantity
 * unit (e.g. $0.04 per image) to the canonical rate. */
export function usdPerUnitToMicrosPerUnit(usdPerUnit: number): MicrosPerUnit {
  return assertRate(usdPerUnit * MICROS_PER_USD, "$/unit rate");
}

/**
 * Convert an operator-entered per-unit price (a decimal string from a form
 * field, e.g. `"0.04"` per image) to the canonical rate, exactly.
 *
 * Distinct from {@link usdPerUnitToMicrosPerUnit}, which multiplies a float and
 * is fine for a literal in the platform registry: an operator can type `"4.03"`,
 * and `4.03 * 1e6` is `4030000.0000000005`, so a float path would store a rate a
 * micro off. Anything originating as human-entered text goes through here.
 */
export function usdDecimalPerUnitToMicrosPerUnit(value: string | number): MicrosPerUnit {
  return usdDecimalToMicros(value) as unknown as MicrosPerUnit;
}

/**
 * Convert a provider's published per-SECOND price (how generative video and
 * audio are quoted) to the canonical per-millisecond rate, since `duration_ms`
 * is the canonical time unit.
 *
 * Named rather than open-coded for the same reason as
 * {@link usdPerMTokToMicrosPerToken}: the `/1000` is a foreign-unit conversion,
 * and foreign units are allowed to exist only inside this module.
 */
export function usdPerSecondToMicrosPerMs(usdPerSecond: number): MicrosPerUnit {
  return assertRate((usdPerSecond * MICROS_PER_USD) / 1000, "$/second rate");
}

/**
 * Convert a decimal currency amount to micros, rounding UP.
 *
 * Accepts a string (preferred — an exact decimal, e.g. from a manifest, an
 * operator's form field, or AWS's Cost & Usage Report) or a number (converted
 * via its shortest round-trip string form, which is exact for any decimal a
 * human or a JSON document actually authored).
 *
 * Parsing is done in `BigInt` on the decimal digits, NOT by multiplying a
 * float: `0.07 * 1e6` is `70000.00000000001`, and a scheme whose whole purpose
 * is exactness cannot afford to begin with a rounding error.
 */
export function usdDecimalToMicros(value: string | number): Micros {
  const raw = typeof value === "number" ? String(value) : value.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    throw new RangeError(`not a decimal currency amount: ${JSON.stringify(value)}`);
  }
  const [, sign, intPart = "", fracPart = "", expPart] = m;
  if (sign === "-") {
    throw new RangeError(`currency amount must not be negative: ${raw}`);
  }

  const digits = BigInt((intPart || "0") + fracPart);
  // Decimal exponent of `digits`, then shifted by 6 to land on micros.
  const exponent = Number(expPart ?? "0") - fracPart.length + 6;

  let micros: bigint;
  if (exponent >= 0) {
    micros = digits * 10n ** BigInt(exponent);
  } else {
    // Finer than a micro: round UP so an amount is never under-counted.
    const divisor = 10n ** BigInt(-exponent);
    micros = digits / divisor + (digits % divisor === 0n ? 0n : 1n);
  }

  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`currency amount too large to represent exactly: ${raw}`);
  }
  return assertMicros(Number(micros), "currency amount");
}

/**
 * Parse a stored price table (a `pricing_json` blob, or an already-parsed object)
 * into validated canonical rates.
 *
 * The single ingest point for stored pricing, so the operator-overrides loader in
 * the installer and the one in the admin UI cannot disagree about what a stored
 * blob means.
 *
 * Entries that are not usable rates are DROPPED rather than thrown on. The
 * trade-off is deliberate: a hand-edited or truncated row would otherwise fail
 * every invocation of the model, whereas a dropped entry merely leaves that
 * dimension unpriced. Dropping is also strictly safer than the alternative for
 * the one case that matters — a NEGATIVE rate, which would credit spend back
 * against the cost gate and defeat the cap. The write path validates before
 * storing, so a dropped entry means the row was tampered with, not authored.
 */
export function parsePricingTable(value: unknown): Record<string, MicrosPerUnit> {
  let obj: unknown = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return {};
  const out: Record<string, MicrosPerUnit> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v as MicrosPerUnit;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cost derivation
// ---------------------------------------------------------------------------

/**
 * The cost of ONE priced measurement: `ceil(quantity × rate)`.
 *
 * Rounding up per line item (rather than once on the total) keeps the total
 * auditable as the sum of its parts, and keeps cost MONOTONE NON-DECREASING in
 * quantity — the property the reserve/reconcile cycle depends on, since it is
 * what guarantees a reconciled cost never exceeds a reservation whose projected
 * quantities bounded the actuals.
 */
export function lineCostMicros(quantity: number, rate: MicrosPerUnit): Micros {
  assertQuantity(quantity);
  assertRate(rate);
  const product = quantity * rate;
  if (product > Number.MAX_SAFE_INTEGER) {
    // See the module doc: the product is ~1e6 larger than the cost, so this
    // trips at roughly $9,007 for a single line item — far outside any real
    // invocation, and a sign of a misconfigured rate rather than real spend.
    throw new RangeError(
      `cost of a single measurement exceeds exact-integer range ` +
        `(quantity ${quantity} × rate ${rate}); check the model's price table`,
    );
  }
  return assertMicros(Math.ceil(product), "line cost");
}

/** A measurement's canonical shape, as consumed by cost derivation. */
export interface PricedMeasurement {
  dimension: string;
  unit: string;
  quantity: number;
}

/**
 * Derive total cost in micros from a measurement set and a model's price table.
 * Each priced `(dimension:unit)` contributes `ceil(quantity × rate)`;
 * unpriced measurements contribute nothing.
 *
 * The `cost` dimension is skipped: cost is DERIVED from other measurements, so
 * pricing it would let a measurement set price its own output.
 */
export function deriveCostMicros(
  pricing: Readonly<Record<string, MicrosPerUnit>>,
  measurements: readonly PricedMeasurement[],
): Micros {
  let total = 0;
  for (const m of measurements) {
    if (m.dimension === COST_DIMENSION) continue;
    const rate = pricing[`${m.dimension}:${m.unit}`];
    if (rate === undefined) continue;
    total += lineCostMicros(m.quantity, rate);
  }
  return assertMicros(total, "total cost");
}

// ---------------------------------------------------------------------------
// Display formatting (canonical-units exception 2)
// ---------------------------------------------------------------------------

/**
 * Render micros as a currency string for a UI — the ONLY place a value leaves
 * canonical units on the way out.
 *
 * Formatted by integer arithmetic on the micros, not by dividing to a float, so
 * the digits shown are exactly the digits stored. Trailing zeros are trimmed
 * below `minDecimals`, so a dashboard total reads `$10.20` while a single
 * request's cost still reads `$0.000102` instead of rounding away to `$0.00`.
 */
export function formatMicrosAsUsd(
  micros: Micros,
  opts: { minDecimals?: number; symbol?: string } = {},
): string {
  const { minDecimals = 2, symbol = "$" } = opts;
  assertMicros(micros);
  const whole = Math.floor(micros / MICROS_PER_USD);
  const frac = micros - whole * MICROS_PER_USD;
  let digits = String(frac).padStart(6, "0");
  while (digits.length > minDecimals && digits.endsWith("0")) {
    digits = digits.slice(0, -1);
  }
  const groupedWhole = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return digits.length > 0 ? `${symbol}${groupedWhole}.${digits}` : `${symbol}${groupedWhole}`;
}

/**
 * Render a token rate in the conventional `$/MTok` the provider publishes.
 * By the identity in {@link usdPerMTokToMicrosPerToken} the number is unchanged
 * — this exists so the convention lives in a named display function rather than
 * being open-coded, and so no caller is tempted to store the result.
 */
export function formatRatePerMTok(rate: MicrosPerUnit): string {
  assertRate(rate);
  return `$${rate}/MTok`;
}

/**
 * A per-unit rate as a NUMBER of whole currency units per unit — for a UI that
 * needs the value rather than a formatted string (a form field's initial value).
 *
 * The single home for this conversion, so a form field and a formatted label can
 * never disagree about what a rate means.
 */
export function ratePerUnitToUsdNumber(rate: MicrosPerUnit): number {
  assertRate(rate);
  return rate / MICROS_PER_USD;
}

/** Render a per-unit rate (micros per unit) as whole currency per unit. */
export function formatRatePerUnit(rate: MicrosPerUnit, unitLabel = "unit"): string {
  return `$${ratePerUnitToUsdNumber(rate)}/${unitLabel}`;
}
