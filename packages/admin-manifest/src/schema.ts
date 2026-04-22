import { z } from "zod";

export const appTierSchema = z.enum(["official", "verified", "community"]);

export const typeDefinitionSchema = z.object({
  typeId: z.string().min(1),
  schemaVersion: z.string().default("1.0.0"),
  description: z.string().default(""),
  schema: z.record(z.unknown()).optional(),
});

export const permissionEntrySchema = z.object({
  subjectType: z.literal("app"),
  resourceType: z.enum(["type", "collection", "wildcard"]),
  resourceId: z.string().min(1),
  permissions: z.array(z.enum(["read", "write", "delete", "admin"])),
  rationale: z.string(),
});

export const infraRequirementSchema = z.object({
  type: z.string(),
  name: z.string(),
  description: z.string().default(""),
});

export const infraRequirementsSchema = z.object({
  database: z.boolean().default(false),
  objectStorage: z.boolean().default(false),
  additionalResources: z.array(infraRequirementSchema).default([]),
});

export const appManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  protocolMinVersion: z.string().default("1.0.0"),
  tier: appTierSchema,
  typeDefinitions: z.array(typeDefinitionSchema).default([]),
  privateTypeDefinitions: z.array(typeDefinitionSchema).default([]),
  requiredPermissions: z.array(permissionEntrySchema).default([]),
  optionalPermissions: z.array(permissionEntrySchema).default([]),
  infraRequirements: infraRequirementsSchema.default({}),
  homepage: z.string().url().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
});

export type AppTier = z.infer<typeof appTierSchema>;
export type TypeDefinition = z.infer<typeof typeDefinitionSchema>;
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type InfraRequirement = z.infer<typeof infraRequirementSchema>;
export type InfraRequirements = z.infer<typeof infraRequirementsSchema>;
export type AppManifest = z.infer<typeof appManifestSchema>;
