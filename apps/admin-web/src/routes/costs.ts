import { fetchMtdCostsByService, projectFullMonth } from "@starkeep/operator/costs";
import { withAdmin } from "../lib/admin-auth";

/** Month-to-date cost by service and its month-end projection, as the signed-in admin. */
export async function POST(_req: Request) {
  return withAdmin(async (admin) => {
    if (!admin.stackPrefix) {
      return Response.json({ error: "~/.starkeep/config.json names no stack" }, { status: 409 });
    }
    try {
      const costs = await fetchMtdCostsByService(admin.stsCredentials, admin.stackPrefix, admin.region);
      return Response.json({ costs, projection: costs ? projectFullMonth(costs) : null });
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
  });
}
