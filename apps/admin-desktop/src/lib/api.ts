import { invoke } from "@tauri-apps/api/core";
import {
  cloudListDeployments,
  cloudGetPlan,
  cloudCreatePlan,
  cloudDeletePlan,
} from "./cloud-client";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function listPlans() {
  if (isTauri()) return invoke("list_plans");
  return cloudListDeployments();
}

export async function getPlan(planId: string) {
  if (isTauri()) return invoke("get_plan", { planId });
  return cloudGetPlan(planId);
}

export async function createPlan(input: {
  stack_name: string;
  region: string;
  environment: string;
  template_type: string;
  parameters: Record<string, unknown> | null;
}) {
  if (isTauri()) return invoke("create_plan", { input });
  return cloudCreatePlan(input);
}

export async function deletePlan(planId: string) {
  if (isTauri()) return invoke("delete_plan", { planId });
  return cloudDeletePlan(planId);
}
