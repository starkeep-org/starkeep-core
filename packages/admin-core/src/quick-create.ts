/**
 * Generate CloudFormation Quick Create links for one-click stack deployment
 */

export interface GenerateQuickCreateLinkInput {
  region: string;
  stackName: string;
  templateUrl: string;
  parameters?: Record<string, string>;
  tags?: Record<string, string>;
}

/**
 * Generate a CloudFormation Quick Create console link
 *
 * This creates a pre-filled CloudFormation console URL that customers can click
 * to deploy or update a stack with all parameters already configured.
 */
export function generateQuickCreateLink(input: GenerateQuickCreateLinkInput): string {
  const baseUrl = `https://${input.region}.console.aws.amazon.com/cloudformation/home`;

  const params = new URLSearchParams({
    region: input.region,
    stackName: input.stackName,
    templateURL: input.templateUrl,
  });

  // Add parameters
  if (input.parameters) {
    Object.entries(input.parameters).forEach(([key, value], index) => {
      params.append(`param_${key}`, value);
    });
  }

  // Add tags
  if (input.tags) {
    Object.entries(input.tags).forEach(([key, value], index) => {
      params.append(`tag_${key}`, value);
    });
  }

  return `${baseUrl}#/stacks/quickcreate?${params.toString()}`;
}

export interface GenerateBootstrapQuickCreateLinkInput {
  region: string;
  templateUrl: string;
  controlPlaneAccountId: string;
  externalId: string;
  stackPrefix?: string;
}

/**
 * Generate a Quick Create link specifically for the bootstrap template
 */
export function generateBootstrapQuickCreateLink(
  input: GenerateBootstrapQuickCreateLinkInput
): string {
  return generateQuickCreateLink({
    region: input.region,
    stackName: 'StarkeeperBootstrap',
    templateUrl: input.templateUrl,
    parameters: {
      ControlPlaneAccountId: input.controlPlaneAccountId,
      ExternalId: input.externalId,
      StackPrefix: input.stackPrefix || 'app',
    },
    tags: {
      ManagedBy: 'Starkeeper',
      Purpose: 'Bootstrap',
    },
  });
}

export interface GenerateChangeSetApprovalLinkInput {
  region: string;
  stackName: string;
  changeSetName: string;
}

/**
 * Generate a console link to review and execute a change set
 *
 * This allows customers to review changes in AWS Console before approving,
 * if they prefer not to use the Starkeeper UI.
 */
export function generateChangeSetApprovalLink(
  input: GenerateChangeSetApprovalLinkInput
): string {
  const baseUrl = `https://${input.region}.console.aws.amazon.com/cloudformation/home`;

  const params = new URLSearchParams({
    region: input.region,
  });

  return `${baseUrl}#/stacks/changesets/changes?${params.toString()}&stackId=${encodeURIComponent(input.stackName)}&changeSetId=${encodeURIComponent(input.changeSetName)}`;
}
