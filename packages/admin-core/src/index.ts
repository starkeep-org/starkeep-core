// Core domain logic for the Starkeep control plane
export * from "./aws-settings.js";
export * from "./deployments.js";
export * from "./plans.js";
export * from "./template-generator.js";

// Unified bootstrap (replaces self-hosted + SaaS distinction)
export {
  generateBootstrapTemplate,
  getCloudFormationCreateStackUrl,
  getBootstrapStackOutputsUrl,
  managerPolicyStatements,
  adminAppPolicyStatements,
  appPermissionsBoundaryStatements,
  type GenerateBootstrapTemplateInput,
} from "./bootstrap/index.js";

// IAM rendering utilities for CloudFormation template generators
export {
  renderStatementsYaml,
  type IamStatement,
  type CfnValue,
} from "./iam-utils.js";
