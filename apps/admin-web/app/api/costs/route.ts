import { NextRequest, NextResponse } from "next/server";
import { fetchMtdCostsByService } from "../../../src/lib/cost-usage-report";
import type { STSCredentials } from "../../../src/lib/cognito-auth";

export async function POST(req: NextRequest) {
  const body = await req.json() as { credentials: STSCredentials; s3Region: string; stackPrefix: string };
  const { credentials, s3Region, stackPrefix } = body;

  try {
    const costs = await fetchMtdCostsByService(credentials, s3Region, stackPrefix);
    return NextResponse.json({ costs });
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as Record<string, unknown>)?.Code ?? (err as Record<string, unknown>)?.code;
    if (code === "NoSuchBucket") {
      return NextResponse.json({ costs: null });
    }
    console.error("[api/costs] error", { name, code, message });
    return NextResponse.json({ error: `${name}: ${message}`, code }, { status: 500 });
  }
}
