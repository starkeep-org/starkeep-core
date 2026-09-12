import { fetchMtdCostsByService } from "../lib/cost-usage-report";
import type { STSCredentials } from "../lib/cognito-auth";

export async function POST(req: Request) {
  const body = await req.json() as { credentials: STSCredentials; stackPrefix: string; region: string };
  const { credentials, stackPrefix, region } = body;

  try {
    const costs = await fetchMtdCostsByService(credentials, stackPrefix, region);
    return Response.json({ costs });
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as Record<string, unknown>)?.Code ?? (err as Record<string, unknown>)?.code;
    if (code === "NoSuchBucket") {
      return Response.json({ costs: null });
    }
    console.error("[api/costs] error", { name, code, message });
    return Response.json({ error: `${name}: ${message}`, code }, { status: 500 });
  }
}
