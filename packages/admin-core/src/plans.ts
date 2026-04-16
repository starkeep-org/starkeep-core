import crypto from "node:crypto";
import type { Plan, ChangeSetChange } from "@starkeep/admin-shared";

export interface CreatePlanInput {
  deploymentId: string;
  changeSetId: string;
  changeSetArn: string;
  changes: ChangeSetChange[];
  templateHash?: string;
  createdBy: string;
}

export interface ApprovePlanInput {
  planId: string;
  approvedBy: string;
}

export class PlanService {
  // In-memory store - replace with real DB
  private plans = new Map<string, Partial<Plan>>();

  createPlan(input: CreatePlanInput): string {
    const planId = crypto.randomUUID();

    this.plans.set(planId, {
      id: planId,
      deploymentId: input.deploymentId,
      changeSetId: input.changeSetId,
      changeSetArn: input.changeSetArn,
      changes: input.changes,
      templateHash: input.templateHash,
      status: "READY",
      createdBy: input.createdBy,
      createdAt: new Date(),
    });

    return planId;
  }

  approvePlan(input: ApprovePlanInput): void {
    const plan = this.plans.get(input.planId);
    if (!plan) {
      throw new Error("Plan not found");
    }

    plan.status = "APPROVED";
    plan.approvedBy = input.approvedBy;
    plan.approvedAt = new Date();
  }

  updateStatus(planId: string, status: Plan["status"]): void {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error("Plan not found");
    }

    plan.status = status;
  }

  getPlan(planId: string): Partial<Plan> | undefined {
    return this.plans.get(planId);
  }

  getPlanByDeployment(deploymentId: string): Partial<Plan> | undefined {
    return Array.from(this.plans.values()).find(
      (p) => p.deploymentId === deploymentId
    );
  }
}
