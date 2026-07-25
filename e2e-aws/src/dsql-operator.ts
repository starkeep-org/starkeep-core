/**
 * Operator-side DSQL access for the Tier-3 journey.
 *
 * The capability broker's cost governance is the one subsystem whose semantics
 * live in SQL — the scoped SUM over a time window, the reserved/committed/
 * released status transitions — and the in-memory fake used by the unit tests
 * is exactly what cannot prove them. So the live journey reads the real ledger
 * and (for the denial test) writes a real gate row.
 *
 * Connects as `${stackPrefix}_installer`, the PG role the admin app's Cognito
 * identity is mapped to at schema init — the same connection admin-web's
 * operator routes use.
 */
import pg from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";

export interface OperatorDsqlOptions {
  hostname: string;
  region: string;
  stackPrefix: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

function installerPgUser(stackPrefix: string): string {
  return `${stackPrefix}_installer`.toLowerCase().replace(/-/g, "_");
}

/** Open a one-connection pool as the installer role. Caller must `end()`. */
export async function connectOperatorDsql(opts: OperatorDsqlOptions): Promise<pg.Pool> {
  const signer = new DsqlSigner({
    hostname: opts.hostname,
    region: opts.region,
    credentials: opts.credentials,
  });
  const token = await signer.getDbConnectAuthToken();
  return new pg.Pool({
    host: opts.hostname,
    port: 5432,
    database: "postgres",
    user: installerPgUser(opts.stackPrefix),
    password: token,
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
}

export interface LedgerRow {
  dimension: string;
  unit: string;
  quantity: number;
  status: string;
  provider: string;
  model: string;
  ts: string;
}

/** Every ledger row for one invocation, oldest first. */
export async function readLedgerRows(
  pool: pg.Pool,
  invocationId: string,
): Promise<LedgerRow[]> {
  const { rows } = await pool.query<LedgerRow>(
    `SELECT dimension, unit, quantity::float8 AS quantity, status, provider, model, ts
       FROM shared.capability_ledger
      WHERE invocation_id = $1
      ORDER BY ts ASC`,
    [invocationId],
  );
  return rows;
}

/** Insert (or replace) a gate row directly — there is no operator gate API yet. */
export async function upsertGate(
  pool: pg.Pool,
  gate: {
    id: string;
    capabilityName: string;
    dimension: string;
    unit: string;
    scopeAppId: string | null;
    limitValue: number;
    windowKind?: "calendar" | "burst";
    windowPeriod?: "week" | "month" | null;
    windowSeconds?: number | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO shared.capability_gates
       (id, capability_name, dimension, unit, scope_provider, scope_model, scope_app_id,
        window_kind, window_period, window_seconds, limit_value, on_exceed, origin)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $7, $8, $9, 'deny', 'operator')
     ON CONFLICT (id) DO UPDATE SET limit_value = EXCLUDED.limit_value`,
    [
      gate.id,
      gate.capabilityName,
      gate.dimension,
      gate.unit,
      gate.scopeAppId,
      gate.windowKind ?? "calendar",
      gate.windowPeriod ?? (gate.windowKind === "burst" ? null : "month"),
      gate.windowSeconds ?? null,
      gate.limitValue,
    ],
  );
}

export async function deleteGate(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(`DELETE FROM shared.capability_gates WHERE id = $1`, [id]);
}

/** The app's consent gate row, if the install wrote one. */
export async function readGate(
  pool: pg.Pool,
  id: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(`SELECT * FROM shared.capability_gates WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
