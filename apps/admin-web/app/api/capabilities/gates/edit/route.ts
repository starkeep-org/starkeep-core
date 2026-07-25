/**
 * Capability usage gates — operator write endpoint (plan §3.5).
 *
 *   POST   — create or update one operator gate (upsert on its id).
 *   DELETE — remove one operator gate.
 *
 * Writes `shared.capability_gates` as the installer PG role. This table is the
 * cost-governance control, so the route is deliberately narrow:
 *
 *   - it only ever touches `operator:`-prefixed ids. The install-time
 *     `consent:<appId>:<capability>` rows are owned by the consent flow and are
 *     re-upserted from the manifest on every reinstall; letting the operator
 *     "tighten" one here would silently revert. Tightening is done by adding an
 *     operator gate — gates are independent and ANY breach denies, so the
 *     stricter one wins without touching the app's row.
 *   - everything the broker could not enforce is rejected up front (see
 *     `validateGateInput`), because a persisted-but-inert row reads as a limit
 *     in the UI while bounding nothing.
 */

import { NextRequest, NextResponse } from "next/server";
import { connectInstallerDsql, dsqlCompiler, DsqlAdminError } from "../../../../../src/lib/dsql-admin";
import {
  validateGateInput,
  isOperatorGateId,
} from "../../../../../src/lib/capability-gates-server";
import type { GateInput } from "../../../../../src/lib/capability-gates";

const TABLE = "shared.capability_gates";

interface WriteBody {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  gate?: GateInput;
  gateId?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as WriteBody;

  const validated = validateGateInput(body.gate);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const cols = validated.columns;

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
    const ins = dsqlCompiler
      .insertInto(TABLE)
      .values({ ...cols })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet((eb) => ({
          capability_name: eb.ref("excluded.capability_name"),
          dimension: eb.ref("excluded.dimension"),
          unit: eb.ref("excluded.unit"),
          scope_provider: eb.ref("excluded.scope_provider"),
          scope_model: eb.ref("excluded.scope_model"),
          scope_app_id: eb.ref("excluded.scope_app_id"),
          window_kind: eb.ref("excluded.window_kind"),
          window_period: eb.ref("excluded.window_period"),
          window_seconds: eb.ref("excluded.window_seconds"),
          limit_value: eb.ref("excluded.limit_value"),
          on_exceed: eb.ref("excluded.on_exceed"),
          origin: eb.ref("excluded.origin"),
        })),
      )
      .compile();
    await pool.query(ins.sql, [...ins.parameters]);
    return NextResponse.json({ ok: true, id: cols.id });
  } catch (err) {
    return NextResponse.json(
      { error: `DSQL write failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as WriteBody;
  const gateId = (body.gateId ?? "").trim();
  if (!gateId) {
    return NextResponse.json({ error: "gateId required" }, { status: 400 });
  }
  if (!isOperatorGateId(gateId)) {
    // Deleting an app's consent gate would REMOVE a spend limit and be undone by
    // the next reinstall anyway; uninstalling the app is what clears it.
    return NextResponse.json(
      {
        error:
          "Only operator-created gates can be deleted here. An app's consent gate is removed " +
          "when that app is uninstalled.",
      },
      { status: 400 },
    );
  }

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
    const del = dsqlCompiler.deleteFrom(TABLE).where("id", "=", gateId).compile();
    await pool.query(del.sql, [...del.parameters]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: `DSQL delete failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  } finally {
    await pool.end().catch(() => {});
  }
}
