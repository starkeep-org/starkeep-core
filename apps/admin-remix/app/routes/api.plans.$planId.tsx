import type { LoaderFunctionArgs } from "@remix-run/node";
import { resolveApiToken, apiError } from "../lib/api-auth.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const auth = await resolveApiToken(request);
  if (!auth) return apiError(401, "Unauthorized");

  const planId = params.planId;
  if (!planId) return apiError(400, "Plan ID is required");

  const { PlansRepository, DeploymentsRepository, AwsSettingsRepository } = await import("@starkeep/admin-db");

  const plansRepo = new PlansRepository();
  const plan = await plansRepo.findById(planId);

  if (!plan) return apiError(404, "Plan not found");
  if (plan.customer_id !== auth.customerId) return apiError(403, "Forbidden");

  const deploymentsRepo = new DeploymentsRepository();
  const deployments = await deploymentsRepo.findByPlanId(planId);
  const latestDeployment = deployments[0] || null;

  let events: unknown[] = [];
  let outputs: unknown[] = [];

  if (latestDeployment) {
    const awsSettingsRepo = new AwsSettingsRepository();
    const settings = await awsSettingsRepo.findByCustomerId(auth.customerId);

    if (settings) {
      const { AwsProvider } = await import("@starkeep/admin-providers");
      const awsProvider = new AwsProvider({
        roleArn: settings.role_arn,
        externalId: settings.external_id,
        executionRoleArn: settings.execution_role_arn || undefined,
        permissionBoundaryArn: settings.permission_boundary_arn || undefined,
      });

      try {
        events = await awsProvider.getDeploymentEvents({
          connectionId: settings.id,
          stackName: plan.stack_name,
          region: plan.region,
          limit: 50,
        });

        if (latestDeployment.status === "COMPLETED" || latestDeployment.status === "IN_PROGRESS") {
          outputs = await awsProvider.getStackOutputs({
            stackName: plan.stack_name,
            region: plan.region,
          });
        }
      } catch {
        // AWS not reachable — return what we have
      }
    }
  }

  return new Response(
    JSON.stringify({ plan, deployment: latestDeployment, events, outputs }),
    { headers: { "Content-Type": "application/json" } },
  );
}
