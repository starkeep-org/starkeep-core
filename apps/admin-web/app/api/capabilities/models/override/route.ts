/**
 * Capability model registry — operator override write endpoint (plan §3.6).
 *
 *   POST   — upsert the sparse override for one model (create/retune).
 *   DELETE — clear a model's override entirely (revert a platform model to its
 *            default, or remove an operator-defined model).
 *
 * Writes `shared.capability_model_overrides` as the installer PG role. A field
 * absent from the posted override is stored NULL (inherits the platform
 * default). An operator-DEFINED model (no platform row) must carry a provider,
 * or it can't be gated/metered.
 */

import { NextRequest, NextResponse } from "next/server";
import { PLATFORM_MODEL_REGISTRY } from "@starkeep/protocol-primitives";
import { connectInstallerDsql, dsqlCompiler, DsqlAdminError } from "../../../../../src/lib/dsql-admin";
import { overrideInputToColumns } from "../../../../../src/lib/capability-models-server";
import type { ModelOverrideInput } from "../../../../../src/lib/capability-models";

// Same shape the manifest validator requires (provider-prefixed id).
const MODEL_ID_RE = /^[a-z0-9]+\.[a-z0-9][a-z0-9._-]*$/;
const PLATFORM_IDS = new Set(PLATFORM_MODEL_REGISTRY.map((m) => m.modelId));
const TABLE = "shared.capability_model_overrides";

interface WriteBody {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  modelId?: string;
  override?: ModelOverrideInput;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as WriteBody;
  const modelId = (body.modelId ?? "").trim();
  const override = body.override ?? {};

  if (!modelId) {
    return NextResponse.json({ error: "modelId required" }, { status: 400 });
  }
  const isPlatform = PLATFORM_IDS.has(modelId);
  if (!isPlatform && !MODEL_ID_RE.test(modelId)) {
    return NextResponse.json(
      { error: "modelId must be a provider-prefixed id, e.g. anthropic.claude-haiku-4-5" },
      { status: 400 },
    );
  }
  // Pricing is edited as a pair — reject a half-set that can't be metered.
  const hasIn = typeof override.inputPerMTok === "number";
  const hasOut = typeof override.outputPerMTok === "number";
  if (hasIn !== hasOut) {
    return NextResponse.json(
      { error: "input and output $/MTok must be set together" },
      { status: 400 },
    );
  }

  const cols = overrideInputToColumns(override);

  // An operator-defined model must resolve to a provider (platform models
  // inherit theirs). Without it the broker can't gate/meter the model.
  if (!isPlatform && !cols.provider) {
    return NextResponse.json(
      { error: "A new (operator-defined) model requires a provider." },
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
    // An entirely-empty override on a platform model is equivalent to no
    // override — delete rather than persist an all-NULL row.
    const empty =
      cols.provider === null &&
      cols.inference_profile_id === null &&
      cols.inference_profile_cleared === false &&
      cols.vision === null &&
      cols.pricing_json === null &&
      cols.estimates_json === null;

    if (isPlatform && empty) {
      const del = dsqlCompiler
        .deleteFrom(TABLE)
        .where("model_id", "=", modelId)
        .compile();
      await pool.query(del.sql, [...del.parameters]);
      return NextResponse.json({ ok: true, cleared: true });
    }

    const ins = dsqlCompiler
      .insertInto(TABLE)
      .values({ model_id: modelId, ...cols })
      .onConflict((oc) =>
        oc.column("model_id").doUpdateSet((eb) => ({
          provider: eb.ref("excluded.provider"),
          inference_profile_id: eb.ref("excluded.inference_profile_id"),
          inference_profile_cleared: eb.ref("excluded.inference_profile_cleared"),
          vision: eb.ref("excluded.vision"),
          pricing_json: eb.ref("excluded.pricing_json"),
          estimates_json: eb.ref("excluded.estimates_json"),
        })),
      )
      .compile();
    await pool.query(ins.sql, [...ins.parameters]);
    return NextResponse.json({ ok: true });
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
  const modelId = (body.modelId ?? "").trim();
  if (!modelId) {
    return NextResponse.json({ error: "modelId required" }, { status: 400 });
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
    const del = dsqlCompiler.deleteFrom(TABLE).where("model_id", "=", modelId).compile();
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
