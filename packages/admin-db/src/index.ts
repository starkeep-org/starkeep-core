// Database client and repositories
export { getPool, closePool } from "./client.js";
export type { Pool, PoolClient, QueryResult, QueryResultRow } from "./client.js";

// Repositories
export { CustomersRepository } from "./repositories/customers.js";
export type { Customer, CreateCustomerInput, UpdateCustomerInput } from "./repositories/customers.js";

export { TemplatesRepository } from "./repositories/templates.js";
export type { Template, CreateTemplateInput, UpdateTemplateInput } from "./repositories/templates.js";

export { PlansRepository } from "./repositories/plans.js";
export type { Plan, CreatePlanInput, UpdatePlanInput } from "./repositories/plans.js";

export { DeploymentsRepository } from "./repositories/deployments.js";
export type { Deployment, CreateDeploymentInput, UpdateDeploymentInput } from "./repositories/deployments.js";

export { DeploymentEventsRepository } from "./repositories/deployment-events.js";
export type { DeploymentEvent, CreateDeploymentEventInput } from "./repositories/deployment-events.js";

export { AwsSettingsRepository } from "./repositories/aws-settings.js";
export type { AwsSettings, CreateAwsSettingsInput, UpdateAwsSettingsInput } from "./repositories/aws-settings.js";

export { AuthRepository } from "./repositories/auth.js";
export type {
  User,
  CustomerMembership,
  AuthPassword,
  AuthSession,
  AuthMagicLink,
  AuthTotp,
  AuthInvitation,
  AuthRecoveryCode,
} from "./repositories/auth.js";

// App ecosystem repositories
export { TypeRegistryRepository } from "./repositories/type-registry.js";
export type { TypeRegistration, CreateTypeRegistrationInput } from "./repositories/type-registry.js";

export { AppRegistryRepository } from "./repositories/app-registry.js";
export type { AppRegistryEntry, CreateAppRegistryInput } from "./repositories/app-registry.js";

export { InfraCatalogRepository } from "./repositories/infra-catalog.js";
export type { InfraCatalogEntry, CreateInfraCatalogInput } from "./repositories/infra-catalog.js";

export { AccessPoliciesRepository } from "./repositories/access-policies.js";
export type { AccessPolicy, CreateAccessPolicyInput } from "./repositories/access-policies.js";

// S3 utilities
export { uploadTemplate, getTemplateUrl, getTemplateKey } from "./s3-upload.js";
export type { UploadTemplateInput, UploadTemplateResult } from "./s3-upload.js";
