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

const RESERVED_SYNC_COLUMNS = new Set(["updated_at", "deleted_at"]);

export const syncableTableColumnSchema = z
  .object({
    name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
    type: z.enum(["text", "integer", "real", "blob", "boolean"]),
    notNull: z.boolean().default(false),
    primaryKey: z.boolean().default(false),
  })
  .refine((col) => !RESERVED_SYNC_COLUMNS.has(col.name), {
    message: `Column names "updated_at" and "deleted_at" are reserved by the sync runtime`,
  });

export const syncableTableSchema = z.object({
  // Becomes "<appId>_syncable_<name>" in the local SQLite schema.
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  columns: z.array(syncableTableColumnSchema).min(1),
});

export const appSpecificSyncableSchema = z.object({
  tables: z.array(syncableTableSchema).default([]),
  // Opt-in for apps/<appId>/syncable/ object-storage prefix.
  files: z.boolean().default(false),
});

export const infraRequirementsSchema = z.object({
  sharedTypeAccess: z.array(sharedTypeAccessSchema).default([]),
  compute: z
    .object({
      enabled: z.boolean().default(false),
      handlers: z.array(appComputeHandlerSchema).default([]),
    })
    .default({}),
  additionalResources: z.array(sharedResourceRequirementSchema).default([]),
  // sts:AssumeRole on ${StackPrefix}-app-* roles — only allowed for the cloud-data-server built-in app.
  brokerPower: z.boolean().default(false),
  // Write access to the built-in `unknown` holding-pen type.
  canIngestUnknown: z.boolean().default(false),
  // Read access to `unknown` plus the right to call promoteFromUnknown.
  canPromoteFromUnknown: z.boolean().default(false),
  appSpecificSyncable: appSpecificSyncableSchema.default({}),
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
  // Ordered ids of shared-schema migrations that belong to this release.
  // Resolved by the installer to .sql files alongside the manifest. Empty for
  // user apps that don't ship shared-schema migrations (the typical case).
  migrations: z.array(z.string()).default([]),
  homepage: z.string().url().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
});

export type AppTier = z.infer<typeof appTierSchema>;
export type SharedTypeAccess = z.infer<typeof sharedTypeAccessSchema>;
export type SharedResourceRequirement = z.infer<typeof sharedResourceRequirementSchema>;
export type AppComputeHandler = z.infer<typeof appComputeHandlerSchema>;
export type SyncableTableColumn = z.infer<typeof syncableTableColumnSchema>;
export type SyncableTable = z.infer<typeof syncableTableSchema>;
export type AppSpecificSyncable = z.infer<typeof appSpecificSyncableSchema>;
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type InfraRequirements = z.infer<typeof infraRequirementsSchema>;
export type AppManifest = z.infer<typeof appManifestSchema>;
