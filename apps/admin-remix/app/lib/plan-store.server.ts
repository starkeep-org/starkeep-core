/**
 * In-memory plan store (replace with database in production)
 *
 * Stores metadata about CloudFormation change sets that have been created.
 */

export interface StoredPlan {
  planId: string;
  stackName: string;
  region: string;
  template: string;
  environment: string;
  changeSetId: string;
  changeSetArn?: string;
  createdAt: string;
}

class PlanStore {
  private plans = new Map<string, StoredPlan>();

  set(plan: StoredPlan): void {
    this.plans.set(plan.planId, plan);
  }

  get(planId: string): StoredPlan | undefined {
    return this.plans.get(planId);
  }

  getAll(): StoredPlan[] {
    return Array.from(this.plans.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  delete(planId: string): boolean {
    return this.plans.delete(planId);
  }
}

export const planStore = new PlanStore();
