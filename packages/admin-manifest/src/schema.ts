import { z } from "zod";

export const appTierSchema = z.enum(["official", "verified", "community"]);

export const sharedTypeAccessSchema = z.object({
  typeId: z.string().min(1),
  access: z.enum(["read", "readwrite"]),
  metadataWrite: z.boolean().default(false),
  rationale: z.string(),
});

export const sharedResourceRequirementSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cloudfront"),
    name: z.string(),
    distributionConfig: z.record(z.unknown()),
  }),
  z.object({
    kind: z.literal("custom"),
    name: z.string(),
    providerId: z.string(),
    config: z.record(z.unknown()),
  }),
]);

export const appComputeHandlerSchema = z.object({
  name: z.string(),
  handler: z.string(),
  runtime: z.enum(["nodejs22.x"]).default("nodejs22.x"),
  memoryMb: z.number().int().min(128).max(10240).default(256),
  timeoutSeconds: z.number().int().min(1).max(900).default(30),
  routes: z.array(z.string()).default(["$default"]),
  env: z.record(z.string()).default({}),
});

export const appPrivateResourceSchema = z.object({
  database: z.boolean().default(true),
  objectStorage: z.boolean().default(true),
  compute: z
    .object({
      enabled: z.boolean().default(false),
      handlers: z.array(appComputeHandlerSchema).default([]),
    })
    .default({}),
  additionalResources: z.array(sharedResourceRequirementSchema).default([]),
  // sts:AssumeRole on ${StackPrefix}-app-* roles — only allowed for the data-server app.
  brokerPower: z.boolean().default(false),
  // Write access to the built-in `unknown` holding-pen type.
  canIngestUnknown: z.boolean().default(false),
  // Read access to `unknown` plus the right to call promoteFromUnknown.
  canPromoteFromUnknown: z.boolean().default(false),
});

export const infraRequirementsSchema = z.object({
  sharedTypeAccess: z.array(sharedTypeAccessSchema).default([]),
  appPrivate: appPrivateResourceSchema.default({}),
  sharedResources: z.array(sharedResourceRequirementSchema).default([]),
});

export const permissionEntrySchema = z.object({
  subjectType: z.literal("app"),
  resourceType: z.enum(["type", "collection", "wildcard"]),
  resourceId: z.string().min(1),
  permissions: z.array(z.enum(["read", "write", "delete", "admin"])),
  rationale: z.string(),
});

export const appManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  protocolMinVersion: z.string().default("1.0.0"),
  tier: appTierSchema,
  requiredPermissions: z.array(permissionEntrySchema).default([]),
  optionalPermissions: z.array(permissionEntrySchema).default([]),
  infraRequirements: infraRequirementsSchema.default({}),
  homepage: z.string().url().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
});

export type AppTier = z.infer<typeof appTierSchema>;
export type SharedTypeAccess = z.infer<typeof sharedTypeAccessSchema>;
export type SharedResourceRequirement = z.infer<typeof sharedResourceRequirementSchema>;
export type AppComputeHandler = z.infer<typeof appComputeHandlerSchema>;
export type AppPrivateResource = z.infer<typeof appPrivateResourceSchema>;
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type InfraRequirements = z.infer<typeof infraRequirementsSchema>;
export type AppManifest = z.infer<typeof appManifestSchema>;
