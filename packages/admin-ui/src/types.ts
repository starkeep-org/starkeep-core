export interface DeploymentPlan {
  id: string;
  stack_name: string;
  region: string;
  environment: string | null;
  status: string;
  parameters: Record<string, unknown> | null;
  change_set_id: string | null;
  created_at: string | Date;
  latestDeployment?: {
    id: string;
    status: string;
    status_reason: string | null;
    stack_id: string | null;
    started_at: string | Date | null;
    completed_at: string | Date | null;
  } | null;
}

export interface DeploymentEventItem {
  timestamp: string | Date;
  resourceType: string;
  logicalResourceId: string;
  physicalResourceId?: string;
  resourceStatus: string;
  resourceStatusReason?: string;
}

export interface StackOutputItem {
  outputKey: string;
  outputValue: string;
  description?: string;
  exportName?: string;
}

export interface ChangeSetChangeItem {
  ResourceChange?: {
    Action?: string;
    ResourceType?: string;
    LogicalResourceId?: string;
    Replacement?: string;
  };
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  parameters?: TemplateParameter[];
}

export interface TemplateParameter {
  name: string;
  label: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  defaultValue?: string;
  options?: string[];
}
