import crypto from "node:crypto";
import type { Deployment } from "@starkeep/admin-shared";

export interface CreateDeploymentInput {
  customerId: string;
  connectionId: string;
  appPackage: string;
  version: string;
  environment: string;
  region: string;
}

export class DeploymentService {
  // In-memory store - replace with real DB
  private deployments = new Map<string, Partial<Deployment>>();

  createDeployment(input: CreateDeploymentInput): string {
    const deploymentId = crypto.randomUUID();
    const stackName = `${input.appPackage}-${input.environment}`;

    this.deployments.set(deploymentId, {
      id: deploymentId,
      customerId: input.customerId,
      connectionId: input.connectionId,
      appPackage: input.appPackage,
      version: input.version,
      environment: input.environment,
      region: input.region,
      stackName,
      status: "IN_PROGRESS",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return deploymentId;
  }

  updateStatus(
    deploymentId: string,
    status: Deployment["status"]
  ): void {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) {
      throw new Error("Deployment not found");
    }

    deployment.status = status;
    deployment.updatedAt = new Date();
  }

  getDeployment(deploymentId: string): Partial<Deployment> | undefined {
    return this.deployments.get(deploymentId);
  }

  listDeployments(customerId: string): Partial<Deployment>[] {
    return Array.from(this.deployments.values()).filter(
      (d) => d.customerId === customerId
    );
  }
}
