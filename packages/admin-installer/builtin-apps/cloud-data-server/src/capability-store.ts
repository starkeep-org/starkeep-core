/**
 * Cloud-side DSQL store for the capability broker (plan §3.2/§3.5/§3.6).
 *
 * Code-isolated from the data-path handlers (a bug here must not corrupt data
 * auth). Supplies only the DSQL source for:
 *   - the caller app's `capability_grants` row,
 *   - the operator's `capability_gates` (matched in-memory by the pure gate
 *     logic in @starkeep/protocol-primitives),
 *   - the operator's model overrides (→ effective model registry),
 *   - the append-only `capability_ledger` (reserve / scoped-SUM / reconcile /
 *     release — the reserve-on-ledger concurrency scheme).
 *
 * All SQL is built with the shared Kysely compiler (postgresCompiler) and run on
 * the caller's per-app DSQL connection, which holds PUBLIC SELECT on these
 * tables and INSERT/UPDATE on the ledger (granted at install).
 */

import { postgresCompiler } from "@starkeep/storage-aurora-dsql";
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";
import {
  generateId,
  windowStartMs,
  type Gate,
  type Measurement,
  type OperatorModelOverride,
  type CapabilityGrantRow,
} from "@starkeep/protocol-primitives";

const GRANTS = "shared.capability_grants";
const GATES = "shared.capability_gates";
const LEDGER = "shared.capability_ledger";
const OVERRIDES = "shared.capability_model_overrides";

/** Load the caller app's grant for one capability; null if not granted. */
export async function loadCapabilityGrant(
  client: DatabaseClient,
  appId: string,
  capabilityName: string,
): Promise<CapabilityGrantRow | null> {
  const q = postgresCompiler
    .selectFrom(GRANTS)
    .select(["models_json", "reports_json"])
    .where("app_id", "=", appId)
    .where("capability_name", "=", capabilityName)
    .compile();
  const { rows } = await client.query(q.sql, [...q.parameters]);
  const row = rows[0] as { models_json?: string; reports_json?: string } | undefined;
  if (!row) return null;
  return {
    appId,
    capabilityName,
    models: safeJsonArray(row.models_json),
    reports: safeJsonArray(row.reports_json),
  };
}

/** Load all capability grants for an app (for the granted-capabilities query). */
export async function loadGrantedCapabilities(
  client: DatabaseClient,
  appId: string,
): Promise<CapabilityGrantRow[]> {
  const q = postgresCompiler
    .selectFrom(GRANTS)
    .select(["capability_name", "models_json", "reports_json"])
    .where("app_id", "=", appId)
    .compile();
  const { rows } = await client.query(q.sql, [...q.parameters]);
  return (rows as Array<{ capability_name: string; models_json: string; reports_json: string }>).map(
    (r) => ({
      appId,
      capabilityName: r.capability_name,
      models: safeJsonArray(r.models_json),
      reports: safeJsonArray(r.reports_json),
    }),
  );
}

/** Look up one committed/reserved ledger row for an invocation (to recover its
 * provider/model when appending a later app-reported output report). Returns
 * null if the invocation isn't the app's. */
export async function lookupInvocation(
  client: DatabaseClient,
  invocationId: string,
  appId: string,
): Promise<{ provider: string; model: string; capabilityName: string } | null> {
  const q = postgresCompiler
    .selectFrom(LEDGER)
    .select(["provider", "model", "capability_name"])
    .where("invocation_id", "=", invocationId)
    .where("app_id", "=", appId)
    .limit(1)
    .compile();
  const { rows } = await client.query(q.sql, [...q.parameters]);
  const r = rows[0] as { provider?: string; model?: string; capability_name?: string } | undefined;
  if (!r?.provider || !r.model || !r.capability_name) return null;
  return { provider: r.provider, model: r.model, capabilityName: r.capability_name };
}

/** Append committed measurement rows for app-reported OUTPUT quantities on a
 * completed invocation (best-effort reconciliation, §3.7). */
export async function appendReportedOutput(
  client: DatabaseClient,
  key: LedgerKey,
  measurements: readonly Measurement[],
): Promise<void> {
  for (const m of measurements) {
    const ins = postgresCompiler
      .insertInto(LEDGER)
      .values({
        id: generateId(),
        invocation_id: key.invocationId,
        app_id: key.appId,
        capability_name: key.capabilityName,
        provider: key.provider,
        model: key.model,
        dimension: m.dimension,
        unit: m.unit,
        quantity: m.quantity,
        status: "committed",
      })
      .compile();
    await client.query(ins.sql, [...ins.parameters]);
  }
}

/** Load every gate for a capability; scope matching is done in-memory by the
 * pure gate logic against the request context. */
export async function loadGates(
  client: DatabaseClient,
  capabilityName: string,
): Promise<Gate[]> {
  const q = postgresCompiler
    .selectFrom(GATES)
    .select([
      "id",
      "dimension",
      "unit",
      "scope_provider",
      "scope_model",
      "scope_app_id",
      "window_kind",
      "window_period",
      "window_seconds",
      "limit_value",
      "on_exceed",
    ])
    .where("capability_name", "=", capabilityName)
    .compile();
  const { rows } = await client.query(q.sql, [...q.parameters]);
  return (rows as unknown as GateRow[]).map(rowToGate);
}

/** Load operator model overrides (→ effective registry, §3.6). */
export async function loadModelOverrides(
  client: DatabaseClient,
): Promise<OperatorModelOverride[]> {
  const q = postgresCompiler
    .selectFrom(OVERRIDES)
    .select([
      "model_id",
      "provider",
      "inference_profile_id",
      "inference_profile_cleared",
      "vision",
      "pricing_json",
      "estimates_json",
    ])
    .compile();
  const { rows } = await client.query(q.sql, [...q.parameters]);
  return (rows as unknown as OverrideRow[]).map((r) => {
    const o: OperatorModelOverride = { modelId: r.model_id };
    if (r.provider) o.provider = r.provider as OperatorModelOverride["provider"];
    if (r.inference_profile_cleared) o.inferenceProfileId = null;
    else if (r.inference_profile_id) o.inferenceProfileId = r.inference_profile_id;
    if (r.vision !== null && r.vision !== undefined) o.vision = r.vision;
    if (r.pricing_json) o.pricing = safeJsonObject(r.pricing_json);
    if (r.estimates_json) o.estimates = safeJsonObject(r.estimates_json);
    return o;
  });
}

// ---------------------------------------------------------------------------
// Ledger — reserve-on-ledger (plan §3.5)
// ---------------------------------------------------------------------------

export interface LedgerKey {
  invocationId: string;
  appId: string;
  capabilityName: string;
  provider: string;
  model: string;
}

/**
 * Append a reservation: one row per projected measurement, all `status =
 * 'reserved'`, each a distinct row (no shared counter → no OCC hotspot under a
 * burst). Returns the invocationId to reconcile/release against.
 */
export async function reserve(
  client: DatabaseClient,
  key: LedgerKey,
  measurements: readonly Measurement[],
): Promise<void> {
  for (const m of measurements) {
    const q = postgresCompiler
      .insertInto(LEDGER)
      .values({
        id: generateId(),
        invocation_id: key.invocationId,
        app_id: key.appId,
        capability_name: key.capabilityName,
        provider: key.provider,
        model: key.model,
        dimension: m.dimension,
        unit: m.unit,
        quantity: m.quantity,
        status: "reserved",
      })
      .compile();
    await client.query(q.sql, [...q.parameters]);
  }
}

/**
 * Scoped SUM over the gate's window, INCLUDING reservations (`reserved` +
 * `committed`; a `released` failed reservation is excluded). Index-served at
 * realistic volumes (§3.5). `timeZone` aligns calendar windows.
 */
export async function sumForGate(
  client: DatabaseClient,
  gate: Gate,
  nowMs: number,
  timeZone: string,
): Promise<number> {
  const startIso = new Date(windowStartMs(gate.window, nowMs, timeZone)).toISOString();
  // No SQL COALESCE (its literal would become a bound parameter and shift the
  // WHERE placeholders) — an empty window returns SQL NULL, coalesced in JS below.
  let q = postgresCompiler
    .selectFrom(LEDGER)
    .select((eb) => eb.fn.sum<number>("quantity").as("total"))
    .where("dimension", "=", gate.dimension)
    .where("unit", "=", gate.unit)
    .where("status", "in", ["reserved", "committed"])
    .where("ts", ">=", startIso);
  if (gate.scope.appId !== undefined) q = q.where("app_id", "=", gate.scope.appId);
  if (gate.scope.provider !== undefined) q = q.where("provider", "=", gate.scope.provider);
  if (gate.scope.model !== undefined) q = q.where("model", "=", gate.scope.model);
  const compiled = q.compile();
  const { rows } = await client.query(compiled.sql, [...compiled.parameters]);
  const total = (rows[0] as { total?: number | string } | undefined)?.total ?? 0;
  return typeof total === "string" ? Number(total) : total;
}

/**
 * True up a reservation to actuals: update each reserved row for the invocation
 * to `committed` with the reconciled quantity, and insert any post-call
 * dimensions the reservation didn't carry (output bytes, app-reported outputs).
 */
export async function reconcile(
  client: DatabaseClient,
  key: LedgerKey,
  measurements: readonly Measurement[],
): Promise<void> {
  for (const m of measurements) {
    // Promote the reserved row for this (dimension,unit) to committed with the
    // trued-up quantity. DatabaseClient doesn't surface a row count, so we then
    // check whether a committed row now exists; if not (a post-call-only
    // dimension the reservation never carried, e.g. output bytes), append one.
    const upd = postgresCompiler
      .updateTable(LEDGER)
      .set({ quantity: m.quantity, status: "committed" })
      .where("invocation_id", "=", key.invocationId)
      .where("dimension", "=", m.dimension)
      .where("unit", "=", m.unit)
      .where("status", "=", "reserved")
      .compile();
    await client.query(upd.sql, [...upd.parameters]);

    const [existsSql, existsParams] = compileExistsCommitted(
      key.invocationId,
      m.dimension,
      m.unit,
    );
    const existing = await client.query(existsSql, existsParams);
    const n = (existing.rows[0] as { n?: number | string } | undefined)?.n;
    if (n && Number(n) > 0) continue;

    const ins = postgresCompiler
      .insertInto(LEDGER)
      .values({
        id: generateId(),
        invocation_id: key.invocationId,
        app_id: key.appId,
        capability_name: key.capabilityName,
        provider: key.provider,
        model: key.model,
        dimension: m.dimension,
        unit: m.unit,
        quantity: m.quantity,
        status: "committed",
      })
      .compile();
    await client.query(ins.sql, [...ins.parameters]);
  }
}

/** Mark a reservation released (failed/aborted call) so its rows drop out of
 * every gate SUM. */
export async function release(client: DatabaseClient, invocationId: string): Promise<void> {
  const q = postgresCompiler
    .updateTable(LEDGER)
    .set({ status: "released" })
    .where("invocation_id", "=", invocationId)
    .where("status", "=", "reserved")
    .compile();
  await client.query(q.sql, [...q.parameters]);
}

function compileExistsCommitted(
  invocationId: string,
  dimension: string,
  unit: string,
): [string, unknown[]] {
  const q = postgresCompiler
    .selectFrom(LEDGER)
    .select((eb) => eb.fn.count<number>("id").as("n"))
    .where("invocation_id", "=", invocationId)
    .where("dimension", "=", dimension)
    .where("unit", "=", unit)
    .where("status", "=", "committed")
    .compile();
  return [q.sql, [...q.parameters]];
}

// ---------------------------------------------------------------------------

interface GateRow {
  id: string;
  dimension: string;
  unit: string;
  scope_provider: string | null;
  scope_model: string | null;
  scope_app_id: string | null;
  window_kind: string;
  window_period: string | null;
  window_seconds: number | null;
  limit_value: number | string;
  on_exceed: string;
}

interface OverrideRow {
  model_id: string;
  provider: string | null;
  inference_profile_id: string | null;
  inference_profile_cleared: boolean | null;
  vision: boolean | null;
  pricing_json: string | null;
  estimates_json: string | null;
}

function rowToGate(r: GateRow): Gate {
  const window: Gate["window"] =
    r.window_kind === "burst"
      ? { kind: "burst", seconds: r.window_seconds ?? 0 }
      : { kind: "calendar", period: (r.window_period as "week" | "month") ?? "month" };
  const scope: Gate["scope"] = {};
  if (r.scope_provider) scope.provider = r.scope_provider as Gate["scope"]["provider"];
  if (r.scope_model) scope.model = r.scope_model;
  if (r.scope_app_id) scope.appId = r.scope_app_id;
  return {
    id: r.id,
    dimension: r.dimension,
    unit: r.unit,
    scope,
    window,
    limit: typeof r.limit_value === "string" ? Number(r.limit_value) : r.limit_value,
    onExceed: "deny",
  };
}

function safeJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function safeJsonObject<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
