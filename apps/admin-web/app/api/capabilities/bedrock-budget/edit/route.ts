/**
 * Bedrock spend guardrail — operator write endpoint (budget-guardrail plan §4.7).
 *
 * POST `{ action, limitUsd? }` where action is one of:
 *   enable    — create/reconcile the budget + action, and record the preference
 *   disable   — delete both, and record the preference so the next install does
 *               not resurrect it
 *   set-limit — re-price the budget (an enable with a new limit)
 *   freeze    — apply the freeze now, without waiting for a breach
 *   resume    — lift a freeze EARLY (it self-clears at the month boundary anyway)
 *
 * Every action performs the AWS mutation; `enable`/`disable` additionally write
 * ~/.starkeep/config.json. The file is only a preference — AWS is the truth — so
 * a failed mutation must never leave a preference claiming otherwise, and the
 * write always follows the call.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  assumeManagerForBudget,
  enableBedrockBudget,
  disableBedrockBudget,
  freeze,
  resume,
  BedrockBudgetError,
} from "../../../../../src/lib/bedrock-budget-server";

type Action = "enable" | "disable" | "set-limit" | "freeze" | "resume";

const ACTIONS: readonly Action[] = ["enable", "disable", "set-limit", "freeze", "resume"];

/** An absurd limit is almost certainly a typo, and a budget nobody can breach is
 * indistinguishable from no budget. $1,000,000/month is far past any plausible
 * personal deployment. */
const MAX_LIMIT_USD = 1_000_000;

function validateLimit(value: unknown): { limitUsd: number } | { error: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { error: "limitUsd must be a number." };
  }
  // Zero would freeze Bedrock the instant anything is spent — never what the
  // operator meant, and "disable" is the way to turn the guardrail off.
  if (value <= 0) return { error: "limitUsd must be greater than zero." };
  if (value > MAX_LIMIT_USD) {
    return { error: `limitUsd must be at most ${MAX_LIMIT_USD}.` };
  }
  return { limitUsd: value };
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    action?: string;
    limitUsd?: unknown;
  };

  const action = body.action as Action | undefined;
  if (!action || !ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${ACTIONS.join(", ")}` },
      { status: 400 },
    );
  }

  let limitUsd: number | undefined;
  if (action === "set-limit" || (action === "enable" && body.limitUsd !== undefined)) {
    const validated = validateLimit(body.limitUsd);
    if ("error" in validated) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    limitUsd = validated.limitUsd;
  }

  try {
    const ctx = await assumeManagerForBudget(body);
    switch (action) {
      case "enable":
      case "set-limit":
        await enableBedrockBudget(ctx, limitUsd);
        return NextResponse.json({ ok: true });
      case "disable":
        await disableBedrockBudget(ctx);
        return NextResponse.json({ ok: true });
      case "freeze":
        return NextResponse.json({ ok: true, frozen: await freeze(ctx) });
      case "resume":
        return NextResponse.json({ ok: true, resumed: await resume(ctx) });
    }
  } catch (err) {
    if (err instanceof BedrockBudgetError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Surfaced as a 5xx with the message rather than a silent { ok: true }:
    // an operator who thinks they raised a limit and didn't is worse off than
    // one who sees the error.
    return NextResponse.json(
      { error: `Budget update failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
