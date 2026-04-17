import type { z } from "zod";
import type * as schemas from "../schemas/index.js";

// Infer types from Zod schemas
export type Customer = z.infer<typeof schemas.customerSchema>;
export type CreateCustomer = z.infer<typeof schemas.createCustomerSchema>;

export type ConnectionStatus = z.infer<typeof schemas.connectionStatus>;
export type AwsConnection = z.infer<typeof schemas.awsConnectionSchema>;

export type DeploymentStatus = z.infer<typeof schemas.deploymentStatus>;
export type Deployment = z.infer<typeof schemas.deploymentSchema>;

export type PlanStatus = z.infer<typeof schemas.planStatusSchema>;
export type ChangeSetChange = z.infer<typeof schemas.changeSetChangeSchema>;
export type Plan = z.infer<typeof schemas.planSchema>;

export type AuditAction = z.infer<typeof schemas.auditActionSchema>;
export type AuditLog = z.infer<typeof schemas.auditLogSchema>;
