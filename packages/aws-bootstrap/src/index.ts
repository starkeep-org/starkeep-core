// Unified bootstrap (replaces self-hosted + SaaS distinction)
export {
  generateBootstrapTemplate,
  getCloudFormationCreateStackUrl,
  getBootstrapStackOutputsUrl,
  managerPolicyStatements,
  adminAppPolicyStatements,
  appPermissionsBoundaryStatements,
  foundationalPermissionsBoundaryStatements,
  installDdlBoundaryStatements,
  installInfraBoundaryStatements,
  bedrockFreezePolicyStatements,
  BEDROCK_FREEZE_EXEMPT_ACTIONS,
  MAX_STACK_PREFIX_LENGTH,
  type GenerateBootstrapTemplateInput,
} from "./bootstrap/index.js";

// Bedrock spend guardrail — the shapes handed to the AWS Budgets API. Pure, no
// SDK, so this stays safe to pull into admin-web's client bundle alongside the
// wizard's template rendering. The SDK-calling operations live in the separate
// `@starkeep/aws-bootstrap/bedrock-budget-ops` entry point, which is
// server-only.
export {
  bedrockBudgetName,
  bedrockBudgetSpec,
  bedrockBudgetActionSpec,
  bedrockFreezeTargetRoleNames,
  bedrockFreezePolicyName,
  bedrockFreezePolicyArn,
  bedrockBudgetActionRoleName,
  bedrockBudgetActionRoleArn,
  BEDROCK_COST_FILTER_SERVICE,
  BUDGETS_REGION,
  type BedrockBudgetSpec,
  type BedrockBudgetActionSpec,
} from "./bedrock-budget-spec.js";

// IAM rendering utilities for CloudFormation template generators
export {
  renderStatementsYaml,
  type IamStatement,
  type CfnValue,
} from "./iam-utils.js";
