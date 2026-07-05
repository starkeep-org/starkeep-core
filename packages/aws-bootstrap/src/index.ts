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
  MAX_STACK_PREFIX_LENGTH,
  type GenerateBootstrapTemplateInput,
} from "./bootstrap/index.js";

// IAM rendering utilities for CloudFormation template generators
export {
  renderStatementsYaml,
  type IamStatement,
  type CfnValue,
} from "./iam-utils.js";
