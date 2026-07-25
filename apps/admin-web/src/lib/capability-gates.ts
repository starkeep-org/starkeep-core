/**
 * Wire types for operator gate management (plan §3.5).
 *
 * A gate is `(dimension, unit, scope, window, limit)` and is THE cost-governance
 * control: every gate whose scope matches a request is evaluated and any breach
 * denies the request (429). Until this editor existed the only row anyone could
 * write was the install-time consent gate derived from an app's own manifest
 * budget — so the only spend limit that could exist was the one the app asked
 * for. This lets the operator add their own global / per-provider / per-model /
 * per-app limits, which is what `dsql-ddl.ts` always claimed they could do.
 *
 * A gate's `limit` is always in the CANONICAL unit of its dimension — micros for
 * `cost`, a plain integer count otherwise (tokens, bytes, requests). An operator
 * naturally thinks in dollars for a spend cap, so the editor's Limit field shows
 * dollars for a cost gate; {@link limitToFieldValue} / {@link fieldValueToLimit}
 * are the only places that conversion happens, and it happens on submit.
 *
 * The dimension catalogue (with its
 * source/timing classification, which decides how the UI must caveat a limit)
 * is served by the list route from the platform's own `DIMENSION_UNIT_SPECS`
 * rather than duplicated here, so a new metered unit shows up without a UI
 * change and the trust classification can never drift.
 */

import {
  COST_DIMENSION,
  assertMicros,
  formatMicrosAsUsd,
  usdDecimalToMicros,
} from "@starkeep/protocol-primitives";

export type GateWindowInput =
  | { kind: "calendar"; period: "week" | "month" }
  | { kind: "burst"; seconds: number };

export interface GateScopeInput {
  /** Model provider, e.g. "anthropic". IAM does not constrain provider at all,
   * so per-provider policy lives entirely in gates. */
  provider?: string;
  model?: string;
  appId?: string;
}

/** A gate as the editor posts it. `id` is absent when creating. */
export interface GateInput {
  id?: string;
  capabilityName: string;
  dimension: string;
  unit: string;
  scope?: GateScopeInput;
  window: GateWindowInput;
  /** Canonical units: micros for a `cost` gate, a plain count otherwise. */
  limit: number;
}

/** True if a gate on `dimensionKey` limits money rather than a count. */
export function isCostGateKey(dimensionKey: string): boolean {
  return dimensionKey.startsWith(`${COST_DIMENSION}:`);
}

/** A canonical limit as the number to put in the editor's Limit field: dollars
 * for a cost gate, the count itself otherwise. */
export function limitToFieldValue(dimensionKey: string, limit: number): string {
  if (!isCostGateKey(dimensionKey)) return String(limit);
  return formatMicrosAsUsd(assertMicros(limit), { symbol: "", minDecimals: 0 }).replace(/,/g, "");
}

/**
 * The Limit field's text back to a canonical limit. Dollars are parsed exactly
 * (never `Number(text) * 1e6` — see money.ts on `"4.03"`); counts must be
 * integers, since every non-cost dimension is metered in a whole quantum.
 *
 * Throws on anything unusable, which doubles as the field's validation.
 */
export function fieldValueToLimit(dimensionKey: string, text: string): number {
  if (isCostGateKey(dimensionKey)) return usdDecimalToMicros(text.trim());
  const n = Number(text.trim());
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`limit must be a non-negative whole number (got ${text})`);
  }
  return n;
}

/** How to label the Limit field for `dimensionKey`. */
export function limitFieldLabel(dimensionKey: string): string {
  return isCostGateKey(dimensionKey) ? "Limit ($)" : "Limit";
}

/** A gate as the list route returns it. */
export interface GateView {
  id: string;
  capabilityName: string;
  dimension: string;
  unit: string;
  scope: GateScopeInput;
  window: GateWindowInput;
  limit: number;
  /** `operator` = created here; `app-consent` = derived from an app's manifest
   * budget at install; null for a hand-written row. */
  origin: string | null;
  /**
   * False for anything this editor does not own. An `app-consent` gate is
   * rewritten by the next install of that app (its limit is upserted from the
   * manifest), so editing it here would silently revert — the operator tightens
   * by ADDING their own gate instead, which is exactly how independent gates
   * are meant to compose (any breach denies).
   */
  editable: boolean;
  createdAt: string | null;
}

/** One `(dimension, unit)` the platform meters, with the classification that
 * decides how a limit on it must be caveated. Mirrors `DIMENSION_UNIT_SPECS`. */
export interface GateDimensionOption {
  key: string;
  dimension: string;
  unit: string;
  /** `cds` = measured by the broker (holds against a hostile app); `app` =
   * self-reported (a cost-shaping convenience, never a boundary). */
  source: "cds" | "app";
  timing: "pre" | "estimated" | "post";
  /** Non-generic pairs must be declared in an app's manifest `reports[]`; a
   * gate on one an app hasn't declared DENIES that app outright (fail closed). */
  generic: boolean;
}

export interface GateListResponse {
  gates: GateView[];
  /** Everything the editor's dropdowns need, sourced from the platform. */
  dimensions: GateDimensionOption[];
  capabilities: string[];
  providers: string[];
}

/** A human summary of a gate's scope. An omitted scope key is a wildcard, so
 * all-omitted reads as "global". */
export function describeScope(scope: GateScopeInput): string {
  const parts: string[] = [];
  if (scope.appId) parts.push(`app ${scope.appId}`);
  if (scope.provider) parts.push(`provider ${scope.provider}`);
  if (scope.model) parts.push(`model ${scope.model}`);
  return parts.length === 0 ? "global" : parts.join(" · ");
}

/** A human summary of a gate's accounting window. */
export function describeWindow(window: GateWindowInput): string {
  return window.kind === "burst" ? `${window.seconds}s burst` : `per ${window.period}`;
}

/** The UI caveat for a limit on `option`, or null when it is a hard limit. */
export function gateCaveat(option: GateDimensionOption): string | null {
  if (option.source === "cds") return null;
  return option.timing === "post"
    ? "app-reported, best-effort: the value only exists after the call and the app supplies it"
    : "app-reported: the app supplies this value and can under-report it";
}
