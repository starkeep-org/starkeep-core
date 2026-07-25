/**
 * Usage gates + cost governance — the security-critical control for the cloud
 * capability broker (plan §3.5). This is the new load-bearing subsystem: it is
 * the single chokepoint that bounds spend / cost-amplification, and it is built
 * and tested as security code.
 *
 * The model is a set of INDEPENDENT gates, each `(dimension, unit, scope,
 * window, limit)`. Every gate whose scope matches a request is evaluated; if ANY
 * would be exceeded, the request is denied (429). Each gate is optional — the
 * operator sets whichever they want and leaves the rest unbounded.
 *
 * Enforcement uses RESERVE-ON-LEDGER concurrency (§3.5): before the call the
 * broker appends a reservation row carrying the worst-case projection; the gate
 * check sums the window INCLUDING reservations; after the call the row is trued
 * up to actuals. The only staleness is in-flight-but-uncommitted reservations,
 * bounded by the burst gate → provable worst-case overage. This module is the
 * pure decision core; the ledger SUM is injected so it works over DSQL in the
 * broker and an in-memory ledger in tests.
 *
 * Two things a gate can deny on:
 *   - EXCEEDED   — projected window total would cross the limit.
 *   - UNDECLARED — the gate targets a non-generic (app-reported) dimension the
 *                  app has NOT declared in its manifest `reports[]`. The app
 *                  can't be metered on it, so it can't be trusted under it →
 *                  fail closed (deny), even before summing.
 */

import {
  dimensionUnitKey,
  isNonGenericDimensionUnit,
} from "./dimensions.js";
import type { EffectiveModel, ModelProvider } from "./models.js";
import { COST_DIMENSION, COST_UNIT, assertQuantity, deriveCostMicros } from "./money.js";

export type CalendarPeriod = "week" | "month";
export type RequestModality = "text" | "image" | "audio" | "video";

/** A gate's scope. Any omitted key is a wildcard; all omitted = global. Keys
 * combine freely (a per-app-per-model gate sets both). */
export interface GateScope {
  provider?: ModelProvider;
  model?: string;
  appId?: string;
}

export type GateWindow =
  | { kind: "calendar"; period: CalendarPeriod }
  | { kind: "burst"; seconds: number };

export interface Gate {
  /** Stable id (row id in the gate table); optional for in-test gates. */
  id?: string;
  dimension: string;
  unit: string;
  scope: GateScope;
  window: GateWindow;
  limit: number;
  /** deny-only for this increment (§3.5 / open question 9). */
  onExceed: "deny";
}

export interface Measurement {
  dimension: string;
  unit: string;
  /**
   * An exact non-negative INTEGER in the canonical unit for `(dimension, unit)`
   * — tokens, bytes, pixels, milliseconds, or micros for `cost`. Never a
   * fractional or coarsened unit; see money.ts and dimensions.ts.
   */
  quantity: number;
}

export interface CapabilityRequestContext {
  appId: string;
  provider: ModelProvider;
  model: string;
  /** App-reported modality class of this request; drives `requests/<modality>`
   * gates and its own fail-closed check. */
  modality?: RequestModality;
}

/** True if `gate`'s scope matches the request. Omitted scope keys are wildcards. */
export function gateMatches(gate: Gate, ctx: CapabilityRequestContext): boolean {
  if (gate.scope.appId !== undefined && gate.scope.appId !== ctx.appId) return false;
  if (gate.scope.provider !== undefined && gate.scope.provider !== ctx.provider) return false;
  if (gate.scope.model !== undefined && gate.scope.model !== ctx.model) return false;
  return true;
}

/**
 * The wall-clock start of the accounting period, as a UTC instant (ms), that a
 * cumulative gate SUMs from. Calendar periods are aligned to `timeZone`
 * (calendar week starts Monday); burst windows are `now − seconds`. Pure so the
 * broker and tests agree on period boundaries (plan §3.5).
 *
 * DST-transition edge cases (a period boundary landing inside a skipped/repeated
 * hour) are resolved to within an hour — immaterial for spend accounting.
 */
export function windowStartMs(
  window: GateWindow,
  nowMs: number,
  timeZone = "UTC",
): number {
  if (window.kind === "burst") {
    return nowMs - Math.max(0, window.seconds) * 1000;
  }
  return calendarPeriodStartMs(window.period, nowMs, timeZone);
}

/** UTC instant for a wall-clock time in `timeZone`. */
function zonedWallToUtcMs(
  y: number,
  m: number,
  d: number,
  timeZone: string,
): number {
  const asUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]),
  );
  // Wall-clock ms that `timeZone` shows for the `asUtc` instant.
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some engines render midnight as 24
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = wall - asUtc;
  return asUtc - offset;
}

export function calendarPeriodStartMs(
  period: CalendarPeriod,
  nowMs: number,
  timeZone = "UTC",
): number {
  // The wall-clock Y/M/D and weekday in `timeZone` for `now`.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  if (period === "month") {
    return zonedWallToUtcMs(y, m, 1, timeZone);
  }
  // Week, Monday start. Map weekday name → 0..6 (Mon=0).
  const idx: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const back = idx[String(parts.weekday)] ?? 0;
  // Start from today's local midnight, then step back `back` local days.
  const todayStart = zonedWallToUtcMs(y, m, d, timeZone);
  return todayStart - back * 86_400_000;
}

export interface GateBreach {
  gate: Gate;
  kind: "exceeded" | "undeclared";
  /** Projected quantity this request contributes to the gate's dimension. */
  projected: number;
  /** Current window total (committed + reserved) before this request. */
  current: number;
}

export interface GateDecision {
  allowed: boolean;
  breaches: GateBreach[];
}

/** Sum the projected measurements that match a gate's `(dimension, unit)`. */
function projectedFor(gate: Gate, projected: readonly Measurement[]): number {
  let total = 0;
  for (const m of projected) {
    if (m.dimension === gate.dimension && m.unit === gate.unit) total += m.quantity;
  }
  return total;
}

/**
 * Evaluate every matching gate against a request's worst-case projection.
 *
 * `getSum(gate)` returns the current window total (committed + in-flight
 * reservations) for the gate's `(scope, dimension, unit, window)`. `appReports`
 * is the set of `"dimension:unit"` keys the app declared it can report; a
 * matching gate on a non-generic dimension NOT in that set fails closed.
 *
 * Deterministic across gates: sums are fetched for every matching gate (no
 * short-circuit) so the returned `breaches` list is complete for logging/UI.
 */
export async function evaluateGates(params: {
  gates: readonly Gate[];
  ctx: CapabilityRequestContext;
  appReports: ReadonlySet<string>;
  projected: readonly Measurement[];
  getSum: (gate: Gate) => Promise<number>;
}): Promise<GateDecision> {
  const { gates, ctx, appReports, projected, getSum } = params;
  const breaches: GateBreach[] = [];

  for (const gate of gates) {
    if (!gateMatches(gate, ctx)) continue;

    const key = dimensionUnitKey(gate.dimension, gate.unit);
    // Fail-closed: a limit on a non-generic dimension the app didn't declare
    // can't be honestly metered → deny before summing.
    if (isNonGenericDimensionUnit(gate.dimension, gate.unit) && !appReports.has(key)) {
      breaches.push({ gate, kind: "undeclared", projected: projectedFor(gate, projected), current: 0 });
      continue;
    }

    const projectedQ = projectedFor(gate, projected);
    const current = await getSum(gate);
    if (current + projectedQ > gate.limit) {
      breaches.push({ gate, kind: "exceeded", projected: projectedQ, current });
    }
  }

  return { allowed: breaches.length === 0, breaches };
}

/**
 * Append the derived `cost` measurement to a measurement set, in place.
 *
 * Cost derivation itself lives in money.ts (the single home for anything that
 * multiplies a quantity by a rate); this helper exists only so the three
 * projection/reconciliation paths below cannot drift in how they attach it.
 */
function pushDerivedCost(out: Measurement[], model: EffectiveModel): void {
  const cost = deriveCostMicros(model.pricing, out);
  if (cost > 0) out.push({ dimension: COST_DIMENSION, unit: COST_UNIT, quantity: cost });
}

export interface ReservationInput {
  model: EffectiveModel;
  ctx: CapabilityRequestContext;
  /** CDS-measured input byte size of the referenced object (S3 HEAD). */
  inputBytes?: number;
  /** Number of input images, for the pre-call token estimate. */
  imageCount?: number;
  /** Pre-call estimate of input TEXT tokens (e.g. chars/4, or app-supplied). */
  inputTextTokenEstimate?: number;
  /** Output ceiling for the reservation — the request's `max_tokens`. */
  maxTokens: number;
  /** App-reported non-generic INPUT quantities, keyed by `"dimension:unit"`
   * (e.g. `{ "input:pixels": 12000000 }`). Only used if declared/known pre-call. */
  appReports?: Readonly<Record<string, number>>;
}

/**
 * The worst-case reservation for a request: the measurement set the broker
 * appends to the ledger BEFORE invoking. Output/cost use the `max_tokens`
 * ceiling + input estimate so a racing request can never under-count in-flight
 * spend. Reconciled to actuals after the call (see {@link reconcileMeasurements}).
 */
export function projectReservation(input: ReservationInput): Measurement[] {
  const { model, ctx, inputBytes, imageCount, inputTextTokenEstimate, maxTokens, appReports } = input;
  const out: Measurement[] = [{ dimension: "requests", unit: "all", quantity: 1 }];

  if (ctx.modality) {
    out.push({ dimension: "requests", unit: ctx.modality, quantity: 1 });
  }
  if (inputBytes !== undefined) {
    out.push({ dimension: "input", unit: "bytes", quantity: inputBytes });
  }

  const imageTokens = (imageCount ?? 0) * (model.estimates.imageTokens ?? 0);
  const inputTokens = (inputTextTokenEstimate ?? 0) + imageTokens;
  if (inputTokens > 0) {
    out.push({ dimension: "input", unit: "tokens", quantity: inputTokens });
  }
  // Reserve the full output ceiling.
  out.push({ dimension: "output", unit: "tokens", quantity: maxTokens });

  // App-reported input quantities (only non-generic keys; the app declared it).
  // assertQuantity here is security-relevant, not hygiene: an app-supplied NaN
  // would poison the window SUM, and `NaN > limit` is false — the gate would then
  // ALLOW every request. Reject at the boundary so that is unrepresentable.
  for (const [key, value] of Object.entries(appReports ?? {})) {
    const [dimension, unit] = key.split(":");
    if (dimension && unit && dimension === "input" && isNonGenericDimensionUnit(dimension, unit)) {
      out.push({ dimension, unit, quantity: assertQuantity(value, `app-reported ${key}`) });
    }
  }

  pushDerivedCost(out, model);
  return out;
}

// ---------------------------------------------------------------------------
// Async (StartAsyncInvoke) output — plan §3.8
// ---------------------------------------------------------------------------
//
// Generation models (video/large image) don't return tokens; their output is
// written to S3 asynchronously and the job is reconciled on completion. So the
// token-shaped projection above doesn't apply — async billing rests on:
//   - `requests` (+ modality) — CDS-measured;
//   - `input:bytes` — CDS-measured (S3 HEAD of the referenced input);
//   - CDS-DERIVED generation output measurements the caller computes from the
//     request's own generation parameters (e.g. requested video `duration_ms`).
//     Because the CDS controls what it asked Bedrock to generate, these are
//     CDS-measured for the purpose of reservation AND reconciliation — the
//     load-bearing `cost` gate is derived from them and holds without any app
//     self-report;
//   - `output:bytes` — CDS-measured post-completion via S3 HEAD (reconcile only,
//     unknown pre-call);
//   - app-reported non-generic quantities — best-effort per §3.5.

export interface AsyncReservationInput {
  model: EffectiveModel;
  ctx: CapabilityRequestContext;
  /** CDS-measured input byte size of the referenced object (S3 HEAD). */
  inputBytes?: number;
  /** CDS-derived worst-case generation output measurements from the request's
   * own parameters (e.g. `[{ output, duration_ms, 6000 }]` for 6s of video). Priced
   * and reserved; trued up to the same CDS-known value on completion. */
  output?: readonly Measurement[];
  /** App-reported non-generic INPUT quantities, keyed by `"dimension:unit"`. */
  appReports?: Readonly<Record<string, number>>;
}

/**
 * The worst-case reservation for an ASYNC generation request (plan §3.8), the
 * measurement set the broker appends to the ledger BEFORE calling
 * StartAsyncInvoke. Mirrors {@link projectReservation} but omits the token
 * ceiling (generation has no output tokens) and reserves the CDS-derived
 * generation output instead. Reconciled on job completion (see
 * {@link reconcileAsyncMeasurements}).
 */
export function projectAsyncReservation(input: AsyncReservationInput): Measurement[] {
  const { model, ctx, inputBytes, output, appReports } = input;
  const out: Measurement[] = [{ dimension: "requests", unit: "all", quantity: 1 }];
  if (ctx.modality) out.push({ dimension: "requests", unit: ctx.modality, quantity: 1 });
  if (inputBytes !== undefined) out.push({ dimension: "input", unit: "bytes", quantity: inputBytes });
  for (const m of output ?? []) out.push({ dimension: m.dimension, unit: m.unit, quantity: m.quantity });

  for (const [key, value] of Object.entries(appReports ?? {})) {
    const [dimension, unit] = key.split(":");
    if (dimension && unit && dimension === "input" && isNonGenericDimensionUnit(dimension, unit)) {
      out.push({ dimension, unit, quantity: assertQuantity(value, `app-reported ${key}`) });
    }
  }

  pushDerivedCost(out, model);
  return out;
}

// Async reconciliation is intentionally NOT a token-shaped re-derivation. Because
// the reservation already captured the CDS-DERIVED worst case (which equals
// actuals for a fixed-duration generation), the broker commits the reservation
// as-is on completion and records the single genuinely-post-call CDS measurement
// — `output:bytes` from an S3 HEAD (see the CDS `commitReservation` +
// output-bytes append in capability-store). Type-specific output (duration,
// frames, pixels) is app-reported best-effort via the ordinary report path.

export interface ReconcileInput {
  model: EffectiveModel;
  ctx: CapabilityRequestContext;
  /** Exact input/output tokens returned by Bedrock's usage. */
  inputTokens: number;
  outputTokens: number;
  /** CDS-measured sizes carried from the reservation / response. */
  inputBytes?: number;
  outputBytes?: number;
  /** App-reported non-generic input+output quantities keyed by `"dimension:unit"`. */
  appReports?: Readonly<Record<string, number>>;
}

/**
 * The reconciled (final) measurement set for a completed invocation — what the
 * ledger reservation row is trued up to. CDS-measured dimensions carry exact
 * values; app-reported quantities are best-effort as supplied. Cost is re-derived
 * from the exact token counts.
 */
export function reconcileMeasurements(input: ReconcileInput): Measurement[] {
  const { model, ctx, inputTokens, outputTokens, inputBytes, outputBytes, appReports } = input;
  const out: Measurement[] = [{ dimension: "requests", unit: "all", quantity: 1 }];
  if (ctx.modality) out.push({ dimension: "requests", unit: ctx.modality, quantity: 1 });
  if (inputBytes !== undefined) out.push({ dimension: "input", unit: "bytes", quantity: inputBytes });
  if (outputBytes !== undefined) out.push({ dimension: "output", unit: "bytes", quantity: outputBytes });
  out.push({ dimension: "input", unit: "tokens", quantity: inputTokens });
  out.push({ dimension: "output", unit: "tokens", quantity: outputTokens });

  for (const [key, value] of Object.entries(appReports ?? {})) {
    const [dimension, unit] = key.split(":");
    if (
      dimension &&
      unit &&
      (dimension === "input" || dimension === "output" || dimension === "credits") &&
      isNonGenericDimensionUnit(dimension, unit)
    ) {
      out.push({ dimension, unit, quantity: assertQuantity(value, `app-reported ${key}`) });
    }
  }

  pushDerivedCost(out, model);
  return out;
}
