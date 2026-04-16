import type { LoaderFunctionArgs } from "@remix-run/node";
import { resolveApiToken, apiError } from "../lib/api-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await resolveApiToken(request);
  if (!auth) return apiError(401, "Unauthorized");

  const { PlansRepository, DeploymentsRepository } = await import("@starkeep/admin-db");

  const plansRepo = new PlansRepository();
  const deploymentsRepo = new DeploymentsRepository();

  const plans = await plansRepo.findByCustomerId(auth.customerId);

  const plansWithDeployments = await Promise.all(
    plans.map(async (plan) => {
      const deployments = await deploymentsRepo.findByPlanId(plan.id);
      return { ...plan, latestDeployment: deployments[0] || null };
    }),
  );

  return new Response(JSON.stringify({ plans: plansWithDeployments }), {
    headers: { "Content-Type": "application/json" },
  });
}
