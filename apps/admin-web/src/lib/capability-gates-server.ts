/**
 * Server-only projection and validation for operator gate management (plan §3.5).
 *
 * The gate table is the security-critical one: a row here is the only thing that
 * bounds spend. So validation fails CLOSED on anything the broker could not act
 * on — an unknown `(dimension, unit)` never sums, an unknown provider never
 * matches, a NaN limit compares false — because each of those persists a row
 * that LOOKS like a limit in the UI while enforcing nothing.
 *
 * Ownership: rows this editor writes are id-prefixed `operator:`. The
 * install-time `consent:<appId>:<capability>` rows belong to the app-consent
 * flow (a reinstall re-upserts their limit), so they are returned read-only and
 * the write routes refuse them.
 */

import {
  DIMENSION_UNIT_SPECS,
  CAPABILITY_REGISTRY,
  dimensionUnitKey,
  isKnownCapability,
  isKnownDimensionUnit,
  generateId,
} from "@starkeep/protocol-primitives";
import type { GateDimensionOption, GateInput, GateView } from "./capability-gates";

/** Raw gate row as selected from DSQL. */
export interface GateDbRow {
  id: string;
  capability_name: string;
  dimension: string;
  unit: string;
  scope_provider: string | null;
  scope_model: string | null;
  scope_app_id: string | null;
  window_kind: string;
  window_period: string | null;
  window_seconds: number | string | null;
  limit_value: number | string;
  on_exceed: string | null;
  origin: string | null;
  created_at: Date | string | null;
}

/** Ids of gates this editor owns. */
export const OPERATOR_GATE_PREFIX = "operator:";

export function isOperatorGateId(id: string): boolean {
  return id.startsWith(OPERATOR_GATE_PREFIX);
}

export function newOperatorGateId(): string {
  return `${OPERATOR_GATE_PREFIX}${generateId()}`;
}

/** The platform's metered pairs, for the editor's dimension dropdown. */
export const GATE_DIMENSION_OPTIONS: readonly GateDimensionOption[] = DIMENSION_UNIT_SPECS.map(
  (s) => ({
    key: dimensionUnitKey(s.dimension, s.unit),
    dimension: s.dimension,
    unit: s.unit,
    source: s.source,
    timing: s.timing,
    generic: s.generic,
  }),
);

export const GATE_CAPABILITY_NAMES: readonly string[] = CAPABILITY_REGISTRY.map((c) => c.name);

/** Providers a gate may scope to. A gate scoped to a provider the registry
 * doesn't know can never match a request, so the write route rejects it. */
export const GATE_PROVIDERS: readonly string[] = [
  "anthropic",
  "amazon",
  "openai",
  "qwen",
  "kimi",
  "glm",
];

function num(v: number | string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * A DSQL row → the wire view. Mirrors the broker's own `rowToGate` defaults so
 * the operator sees exactly the limit that will be enforced: a burst row with a
 * null `window_seconds` is a 0-second window (i.e. only in-flight requests
 * count), and a calendar row with no period is monthly.
 */
export function rowToGateView(row: GateDbRow): GateView {
  const window: GateView["window"] =
    row.window_kind === "burst"
      ? { kind: "burst", seconds: num(row.window_seconds) ?? 0 }
      : { kind: "calendar", period: row.window_period === "week" ? "week" : "month" };
  const scope: GateView["scope"] = {};
  if (row.scope_provider) scope.provider = row.scope_provider;
  if (row.scope_model) scope.model = row.scope_model;
  if (row.scope_app_id) scope.appId = row.scope_app_id;
  return {
    id: row.id,
    capabilityName: row.capability_name,
    dimension: row.dimension,
    unit: row.unit,
    scope,
    window,
    limit: num(row.limit_value) ?? 0,
    origin: row.origin ?? null,
    editable: isOperatorGateId(row.id),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at ?? null),
  };
}

/** The columns persisted for one operator gate. */
export interface GateColumns {
  id: string;
  capability_name: string;
  dimension: string;
  unit: string;
  scope_provider: string | null;
  scope_model: string | null;
  scope_app_id: string | null;
  window_kind: string;
  window_period: string | null;
  window_seconds: number | null;
  limit_value: number;
  on_exceed: string;
  origin: string;
}

export type GateValidation = { error: string } | { columns: GateColumns };

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Validate a posted gate and project it to columns. Rejects anything the broker
 * could not enforce, so a saved row always means what the table shows.
 */
export function validateGateInput(input: GateInput | undefined): GateValidation {
  if (!input || typeof input !== "object") return { error: "gate required" };

  const id = trimOrNull(input.id) ?? newOperatorGateId();
  if (!isOperatorGateId(id)) {
    return {
      error:
        "Only operator-created gates can be edited here. An app's consent gate is rewritten " +
        "on its next install — add your own gate to tighten it.",
    };
  }

  const capabilityName = trimOrNull(input.capabilityName);
  if (!capabilityName) return { error: "capabilityName required" };
  if (!isKnownCapability(capabilityName)) {
    return { error: `Unknown capability "${capabilityName}".` };
  }

  const dimension = trimOrNull(input.dimension);
  const unit = trimOrNull(input.unit);
  if (!dimension || !unit) return { error: "dimension and unit required" };
  if (!isKnownDimensionUnit(dimension, unit)) {
    // An unmetered pair is never summed, so the gate would sit in the table
    // reading as a limit while allowing unbounded spend.
    return { error: `"${dimensionUnitKey(dimension, unit)}" is not a metered (dimension, unit) pair.` };
  }

  const limit = input.limit;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
    return { error: "limit must be a non-negative number" };
  }

  const window = input.window;
  if (!window || typeof window !== "object") return { error: "window required" };
  let window_kind: string;
  let window_period: string | null = null;
  let window_seconds: number | null = null;
  if (window.kind === "calendar") {
    if (window.period !== "week" && window.period !== "month") {
      return { error: "calendar window period must be week or month" };
    }
    window_kind = "calendar";
    window_period = window.period;
  } else if (window.kind === "burst") {
    const seconds = window.seconds;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1) {
      return { error: "burst window seconds must be a positive whole number" };
    }
    window_kind = "burst";
    window_seconds = seconds;
  } else {
    return { error: "window kind must be calendar or burst" };
  }

  const scope = input.scope ?? {};
  const scope_provider = trimOrNull(scope.provider);
  if (scope_provider !== null && !GATE_PROVIDERS.includes(scope_provider)) {
    // A gate scoped to an unknown provider matches nothing — silently inert.
    return { error: `Unknown provider "${scope_provider}".` };
  }

  return {
    columns: {
      id,
      capability_name: capabilityName,
      dimension,
      unit,
      scope_provider,
      scope_model: trimOrNull(scope.model),
      scope_app_id: trimOrNull(scope.appId),
      window_kind,
      window_period,
      window_seconds,
      limit_value: limit,
      // deny-only for this increment (plan §3.5); there is no soft-budget mode.
      on_exceed: "deny",
      origin: "operator",
    },
  };
}
