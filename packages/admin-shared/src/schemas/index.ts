import { z } from "zod";

// Customer schemas
export const createCustomerSchema = z.object({
  companyName: z.string().min(1),
  accountId: z.string().min(12).max(12), // AWS account ID
  allowedRegions: z.array(z.string()).optional(),
  stackPrefix: z.string().optional(),
});

export const customerSchema = z.object({
  id: z.string(),
  companyName: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Connection schemas
export const connectionStatus = z.enum([
  "DRAFT",
  "BOOTSTRAP_LAUNCHED",
  "VERIFIED",
  "REVOKED",
]);

export const awsConnectionSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  accountId: z.string(),
  externalId: z.string(),
  delegatedRoleArn: z.string().optional(),
  executionRoleArn: z.string().optional(),
  allowedRegions: z.array(z.string()).optional(),
  stackPrefix: z.string().optional(),
  status: connectionStatus,
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Deployment schemas
export const deploymentStatus = z.enum([
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "ROLLED_BACK",
]);

export const deploymentSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  connectionId: z.string(),
  appPackage: z.string(),
  version: z.string(),
  environment: z.string(),
  region: z.string(),
  stackName: z.string(),
  status: deploymentStatus,
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Plan schemas
export const planStatusSchema = z.enum([
  "CREATING",
  "READY",
  "APPROVED",
  "EXECUTING",
  "COMPLETED",
  "FAILED",
]);

export const changeSetChangeSchema = z.object({
  action: z.enum(["Add", "Modify", "Remove", "Import", "Dynamic"]),
  resourceType: z.string(),
  logicalResourceId: z.string(),
  physicalResourceId: z.string().optional(),
  replacement: z.enum(["True", "False", "Conditional"]).optional(),
  scope: z.array(z.string()).optional(),
  details: z.array(z.unknown()).optional(),
});

export const planSchema = z.object({
  id: z.string(),
  deploymentId: z.string(),
  changeSetId: z.string(),
  changeSetArn: z.string().optional(),
  changes: z.array(changeSetChangeSchema),
  templateHash: z.string().optional(),
  status: planStatusSchema,
  createdBy: z.string(),
  approvedBy: z.string().optional(),
  createdAt: z.date(),
  approvedAt: z.date().optional(),
});

// Audit log schemas
export const auditActionSchema = z.enum([
  "PLAN_CREATED",
  "APPROVED",
  "EXEC_STARTED",
  "EXEC_SUCCEEDED",
  "EXEC_FAILED",
  "REVOKED",
]);

export const auditLogSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  deploymentId: z.string().optional(),
  planId: z.string().optional(),
  action: auditActionSchema,
  actor: z.string(),
  metadata: z.record(z.any()).optional(),
  createdAt: z.date(),
});
