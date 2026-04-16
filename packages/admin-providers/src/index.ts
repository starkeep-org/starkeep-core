// Base provider interface
export interface PlanResult {
  planId: string;
  changeSetId: string;
  changeSetArn?: string;
  changes: ChangeSetChange[];
  status: "CREATING" | "READY" | "FAILED";
}

export interface ApplyResult {
  deploymentId: string;
  stackId: string;
  stackArn?: string;
  status: "IN_PROGRESS" | "COMPLETE" | "FAILED" | "ROLLBACK_COMPLETE";
  events?: DeploymentEvent[];
}

export interface DeploymentEvent {
  timestamp: Date;
  resourceType: string;
  logicalResourceId: string;
  physicalResourceId?: string;
  resourceStatus: string;
  resourceStatusReason?: string;
}

export interface ChangeSetChange {
  action: "Add" | "Modify" | "Remove" | "Import" | "Dynamic";
  resourceType: string;
  logicalResourceId: string;
  physicalResourceId?: string;
  replacement?: "True" | "False" | "Conditional";
  scope?: string[];
  details?: any[];
}

export interface PlanDeploymentInput {
  connectionId: string;
  stackName: string;
  templateUrl: string;
  parameters?: Record<string, string>;
  tags?: Record<string, string>;
  region: string;
}

export interface ApplyDeploymentInput {
  connectionId: string;
  planId: string;
  changeSetId: string;
  stackName: string;
  region: string;
}

export interface GetDeploymentEventsInput {
  connectionId: string;
  stackName: string;
  region: string;
  limit?: number;
}

export interface StackOutput {
  outputKey: string;
  outputValue: string;
  description?: string;
  exportName?: string;
}

export interface GetStackOutputsInput {
  stackName: string;
  region: string;
}

// Base provider interface - cloud-agnostic
export interface Provider {
  planDeployment(input: PlanDeploymentInput): Promise<PlanResult>;
  applyDeployment(input: ApplyDeploymentInput): Promise<ApplyResult>;
  getDeploymentEvents(input: GetDeploymentEventsInput): Promise<DeploymentEvent[]>;
  getStackOutputs?(input: GetStackOutputsInput): Promise<StackOutput[]>;
}

// Export AWS provider implementation
export { AwsProvider, type AwsProviderConfig } from "./aws/index.js";
