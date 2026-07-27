/**
 * Bedrock spend guardrail — operator read endpoint (budget-guardrail plan §4.7).
 *
 * POST with the admin session's STS credentials; assumes Manager and returns the
 * LIVE state from AWS (does the budget exist, what is its limit, what has been
 * spent this month, is the freeze policy currently attached) merged with the
 * operator's persisted preference.
 *
 * Live-not-cached is a requirement, not an optimisation: a freeze self-clears at
 * the month boundary, so a cached "we froze it" flag would leave a banner
 * claiming every app is broken long after they recovered.
 *
 * Also reads the seeded global `cost` gate's limit, so the UI can show the soft
 * ceiling beside the hard one. The two are independent by design — the defaults
 * cohere, the values do not stay coupled — which makes displaying them together
 * the only thing that makes a divergence legible.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  assumeManagerForBudget,
  getBedrockBudgetView,
  BedrockBudgetError,
} from "../../../../src/lib/bedrock-budget-server";
import { connectInstallerDsql, dsqlCompiler, DsqlAdminError } from "../../../../src/lib/dsql-admin";

/** Id of the gate `initializeSharedSchema` seeds (§4.6). */
const SEEDED_GATE_ID = "operator:bedrock-monthly-cost";
const MICROS_PER_USD = 1_000_000;

/** The seeded global gate's limit in dollars, or null when the operator deleted
 * it. Best-effort: DSQL being unreachable must not blank the budget panel. */
async function readGlobalCostGateUsd(creds: {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}): Promise<number | null> {
  let pool;
  try {
    pool = await connectInstallerDsql(creds);
  } catch (err) {
    if (err instanceof DsqlAdminError) return null;
    throw err;
  }
  try {
    const q = dsqlCompiler
      .selectFrom("shared.capability_gates")
      .select(["limit_value"])
      .where("id", "=", SEEDED_GATE_ID)
      .compile();
    const { rows } = await pool.query<{ limit_value: string | number }>(q.sql, [...q.parameters]);
    const raw = rows[0]?.limit_value;
    if (raw === undefined) return null;
    const micros = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(micros) ? micros / MICROS_PER_USD : null;
  } catch {
    return null;
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };

  try {
    const ctx = await assumeManagerForBudget(body);
    const gateUsd = await readGlobalCostGateUsd(body);
    return NextResponse.json(await getBedrockBudgetView(ctx, gateUsd));
  } catch (err) {
    if (err instanceof BedrockBudgetError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: `Budget status failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
