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
 * Client-safe: no runtime imports. The dimension catalogue (with its
 * source/timing classification, which decides how the UI must caveat a limit)
 * is served by the list route from the platform's own `DIMENSION_UNIT_SPECS`
 * rather than duplicated here, so a new metered unit shows up without a UI
 * change and the trust classification can never drift.
 */

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
  limit: number;
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
