/**
 * An in-memory DatabaseClient that models the exact SQL `capability-store.ts`
 * emits — including the parts the earlier ad-hoc fake ignored:
 *
 *  - `ts >= $startIso`, so a gate's WINDOW actually excludes rows outside it
 *    (burst windows, calendar rollover, rows ageing out);
 *  - the append-only ledger's `status` transitions with their `WHERE status =`
 *    guards (release/commit/markAsyncJobStatus idempotency);
 *  - SQL NULL for an empty SUM (the store coalesces in JS, deliberately without
 *    a SQL COALESCE — see the placeholder-shift comment in `sumForGate`);
 *  - the `app_id` filter on `capability_async_jobs` / invocation lookup, which is
 *    the only thing preventing cross-app reads on a PUBLIC-SELECT table.
 *
 * Rows are timestamped from an injectable clock so a test can insert history at
 * a chosen instant and then evaluate a gate "later".
 */
import type { DatabaseClient } from "@starkeep/storage-aurora-dsql";

export interface LedgerRow {
  id: string;
  invocation_id: string;
  app_id: string;
  capability_name: string;
  provider: string;
  model: string;
  dimension: string;
  unit: string;
  quantity: number;
  status: string;
  ts: string;
}

export interface AsyncJobRowDb {
  invocation_id: string;
  app_id: string;
  capability_name: string;
  provider: string;
  model: string;
  invocation_arn: string;
  output_bucket: string;
  output_key_prefix: string;
  status: string;
}

export interface GateSeed {
  id?: string;
  dimension: string;
  unit: string;
  scope_provider?: string | null;
  scope_model?: string | null;
  scope_app_id?: string | null;
  window_kind?: string;
  window_period?: string | null;
  window_seconds?: number | null;
  limit_value: number | string;
  on_exceed?: string;
}

export interface GrantSeed {
  models: string[];
  reports: string[];
}

export interface InMemoryCapabilityDbOptions {
  /** Grant for a single app (`photos` by default), or a per-app map. */
  grant?: GrantSeed | null;
  grantsByApp?: Record<string, GrantSeed>;
  gates?: GateSeed[];
  overrides?: Record<string, unknown>[];
  /** Clock used to stamp `ts` on inserted ledger rows (default: Date.now). */
  now?: () => number;
}

export class InMemoryCapabilityDb implements DatabaseClient {
  ledger: LedgerRow[] = [];
  asyncJobs: AsyncJobRowDb[] = [];
  /** Every statement executed, for SQL-shape assertions. */
  readonly log: Array<{ text: string; values: unknown[] }> = [];
  now: () => number;

  private readonly grantsByApp: Record<string, GrantSeed>;
  private readonly gates: GateSeed[];
  private readonly overrides: Record<string, unknown>[];

  constructor(opts: InMemoryCapabilityDbOptions = {}) {
    this.grantsByApp = opts.grantsByApp ?? (opts.grant ? { photos: opts.grant } : {});
    this.gates = opts.gates ?? [];
    this.overrides = opts.overrides ?? [];
    this.now = opts.now ?? Date.now;
  }

  /** Seed a ledger row directly (history predating the test's own calls). */
  seedLedger(row: Partial<LedgerRow> & Pick<LedgerRow, "dimension" | "unit" | "quantity">): void {
    this.ledger.push({
      id: `seed-${this.ledger.length}`,
      invocation_id: `seed-inv-${this.ledger.length}`,
      app_id: "photos",
      capability_name: "bedrock.invoke",
      provider: "anthropic",
      model: "anthropic.claude-haiku-4-5",
      status: "committed",
      ts: new Date(this.now()).toISOString(),
      ...row,
    });
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.log.push({ text, values });
    const v = values;

    if (text.includes('"capability_grants"')) {
      // loadCapabilityGrant: [appId, capabilityName]; loadGrantedCapabilities: [appId]
      const appId = String(v[0]);
      const g = this.grantsByApp[appId];
      if (!g) return { rows: [] };
      // `loadGrantedCapabilities` (no capability_name predicate) also selects the
      // name column; `loadCapabilityGrant` filters on it and doesn't.
      return {
        rows: [
          {
            models_json: JSON.stringify(g.models),
            reports_json: JSON.stringify(g.reports),
            ...(text.includes('"capability_name" =') ? {} : { capability_name: "bedrock.invoke" }),
          },
        ],
      };
    }

    if (text.includes('"capability_gates"')) {
      return {
        rows: this.gates.map((g, i) => ({
          id: g.id ?? `g${i}`,
          dimension: g.dimension,
          unit: g.unit,
          scope_provider: g.scope_provider ?? null,
          scope_model: g.scope_model ?? null,
          scope_app_id: g.scope_app_id ?? null,
          window_kind: g.window_kind ?? "calendar",
          window_period: g.window_period ?? "month",
          window_seconds: g.window_seconds ?? null,
          limit_value: g.limit_value,
          on_exceed: g.on_exceed ?? "deny",
        })),
      };
    }

    if (text.includes('"capability_model_overrides"')) {
      return { rows: this.overrides };
    }

    if (text.includes('"capability_async_jobs"')) {
      if (text.startsWith("insert into")) {
        const [
          invocation_id,
          app_id,
          capability_name,
          provider,
          model,
          invocation_arn,
          output_bucket,
          output_key_prefix,
          status,
        ] = v as string[];
        this.asyncJobs.push({
          invocation_id: invocation_id!,
          app_id: app_id!,
          capability_name: capability_name!,
          provider: provider!,
          model: model!,
          invocation_arn: invocation_arn!,
          output_bucket: output_bucket!,
          output_key_prefix: output_key_prefix!,
          status: status!,
        });
        return { rows: [] };
      }
      if (text.startsWith("update")) {
        // markAsyncJobStatus: [status, invocationId, 'running']
        const [status, inv, guard] = v as [string, string, string];
        for (const j of this.asyncJobs) {
          if (j.invocation_id === inv && j.status === guard) j.status = status;
        }
        return { rows: [] };
      }
      // loadAsyncJob: [invocationId, appId]
      const [inv, appId] = v as [string, string];
      const job = this.asyncJobs.find((j) => j.invocation_id === inv && j.app_id === appId);
      return { rows: job ? [{ ...job }] : [] };
    }

    if (text.includes('"capability_ledger"')) {
      if (text.startsWith("insert into")) {
        // id, invocation_id, app_id, capability_name, provider, model,
        // dimension, unit, quantity, status
        this.ledger.push({
          id: String(v[0]),
          invocation_id: String(v[1]),
          app_id: String(v[2]),
          capability_name: String(v[3]),
          provider: String(v[4]),
          model: String(v[5]),
          dimension: String(v[6]),
          unit: String(v[7]),
          quantity: Number(v[8]),
          status: String(v[9]),
          ts: new Date(this.now()).toISOString(),
        });
        return { rows: [] };
      }

      if (text.startsWith("select sum")) {
        // dimension, unit, 'reserved', 'committed', startIso, [app_id][provider][model]
        const [dimension, unit, s1, s2, startIso, ...scope] = v as string[];
        const statuses = [s1, s2];
        const scopeCols: string[] = [];
        if (text.includes('"app_id" =')) scopeCols.push("app_id");
        if (text.includes('"provider" =')) scopeCols.push("provider");
        if (text.includes('"model" =')) scopeCols.push("model");
        const matching = this.ledger
          .filter((r) => r.dimension === dimension && r.unit === unit)
          .filter((r) => statuses.includes(r.status))
          .filter((r) => r.ts >= startIso!)
          .filter((r) =>
            scopeCols.every(
              (c, i) => (r as unknown as Record<string, unknown>)[c] === scope[i],
            ),
          );
        // Postgres SUM over an empty set is NULL, and the driver hands numerics
        // back as strings — model both, since the store coalesces in JS.
        if (matching.length === 0) return { rows: [{ total: null }] };
        return {
          rows: [{ total: String(matching.reduce((sum, r) => sum + r.quantity, 0)) }],
        };
      }

      if (text.startsWith("select count")) {
        // exists-committed probe: invocation_id, dimension, unit, status
        const [inv, dim, unit, status] = v as [string, string, string, string];
        const n = this.ledger.filter(
          (r) =>
            r.invocation_id === inv &&
            r.dimension === dim &&
            r.unit === unit &&
            r.status === status,
        ).length;
        return { rows: [{ n: String(n) }] };
      }

      if (text.startsWith("update")) {
        if (text.includes('"quantity" =')) {
          // reconcile: quantity, status, invocation_id, dimension, unit, 'reserved'
          const [qty, status, inv, dim, unit, guard] = v as [
            number,
            string,
            string,
            string,
            string,
            string,
          ];
          for (const r of this.ledger) {
            if (
              r.invocation_id === inv &&
              r.dimension === dim &&
              r.unit === unit &&
              r.status === guard
            ) {
              r.quantity = qty;
              r.status = status;
            }
          }
        } else {
          // release / commitReservation: status, invocation_id, 'reserved'
          const [status, inv, guard] = v as [string, string, string];
          for (const r of this.ledger) {
            if (r.invocation_id === inv && r.status === guard) r.status = status;
          }
        }
        return { rows: [] };
      }

      // lookupInvocation: invocation_id, app_id
      const [inv, appId] = v as [string, string];
      const row = this.ledger.find((r) => r.invocation_id === inv && r.app_id === appId);
      return {
        rows: row
          ? [{ provider: row.provider, model: row.model, capability_name: row.capability_name }]
          : [],
      };
    }

    throw new Error(`InMemoryCapabilityDb: unhandled SQL: ${text}`);
  }

  async end(): Promise<void> {}
}
