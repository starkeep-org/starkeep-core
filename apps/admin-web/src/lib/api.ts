import {
  cloudListDeployments,
  cloudGetPlan,
  cloudCreatePlan,
  cloudDeletePlan,
} from "./cloud-client";

export async function listPlans() {
  return cloudListDeployments();
}

export async function getPlan(planId: string) {
  return cloudGetPlan(planId);
}

export async function createPlan(input: {
  stack_name: string;
  region: string;
  environment: string;
  template_type: string;
  parameters: Record<string, unknown> | null;
}) {
  return cloudCreatePlan(input);
}

export async function deletePlan(planId: string) {
  return cloudDeletePlan(planId);
}
