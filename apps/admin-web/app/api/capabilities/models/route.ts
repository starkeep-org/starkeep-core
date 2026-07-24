/**
 * Capability model registry — operator read endpoint (plan §3.6).
 *
 * POST with the admin session's STS credentials; returns the effective model
 * registry: every platform model plus any operator-defined models, each with
 * its merged (effective) values, the platform defaults, and the raw sparse
 * override. The operator editor renders this and posts changes to
 * `./models/override`.
 */

import { NextRequest, NextResponse } from "next/server";
import { connectInstallerDsql, dsqlCompiler, DsqlAdminError } from "../../../../src/lib/dsql-admin";
import {
  buildModelRows,
  type OverrideRow,
} from "../../../../src/lib/capability-models-server";
import type { ModelRegistryResponse } from "../../../../src/lib/capability-models";

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
      .selectFrom("shared.capability_model_overrides")
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
    const { rows } = await pool.query<OverrideRow>(q.sql, [...q.parameters]);
    const response: ModelRegistryResponse = { models: buildModelRows(rows) };
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
