/**
 * Capability usage gates — operator read endpoint (plan §3.5).
 *
 * POST with the admin session's STS credentials; returns every row of
 * `shared.capability_gates` (the operator's own gates plus the read-only
 * install-time consent gates), together with the platform catalogue the editor's
 * dropdowns need: which `(dimension, unit)` pairs are metered and how each is
 * measured, which capabilities exist, and which providers a scope may name.
 *
 * Serving the catalogue from here rather than duplicating it in the client keeps
 * the CDS-measured vs app-reported classification — which decides how a limit
 * must be caveated — sourced from the platform's own table.
 */

import { NextRequest, NextResponse } from "next/server";
import { connectInstallerDsql, dsqlCompiler, DsqlAdminError } from "../../../../src/lib/dsql-admin";
import {
  rowToGateView,
  GATE_DIMENSION_OPTIONS,
  GATE_CAPABILITY_NAMES,
  GATE_PROVIDERS,
  type GateDbRow,
} from "../../../../src/lib/capability-gates-server";
import type { GateListResponse } from "../../../../src/lib/capability-gates";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };

  let pool;
  try {
    pool = await connectInstallerDsql(body);
  } catch (err) {
    if (err instanceof DsqlAdminError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  try {
    const q = dsqlCompiler
      .selectFrom("shared.capability_gates")
      .select([
        "id",
        "capability_name",
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
        "origin",
        "created_at",
      ])
      .compile();
    const { rows } = await pool.query<GateDbRow>(q.sql, [...q.parameters]);
    const response: GateListResponse = {
      gates: rows.map(rowToGateView),
      dimensions: [...GATE_DIMENSION_OPTIONS],
      capabilities: [...GATE_CAPABILITY_NAMES],
      providers: [...GATE_PROVIDERS],
    };
    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      { error: `DSQL query failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}
