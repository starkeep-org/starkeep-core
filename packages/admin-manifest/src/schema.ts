import { z } from "zod";

export const appTierSchema = z.enum(["official", "verified", "community"]);

// Where an app can be installed. An app may target local, cloud, or both. The
// Apps page derives its Local / Cloud lists from this field.
export const appTargetSchema = z.enum(["local", "cloud"]);

/**
 * An app's grant over a set of file extensions. Installable apps enumerate the
 * exact lowercase extensions they handle (no dot, alphanumeric). Validation
 * rejects any extension not in the platform map, so the unmapped (`other`) set
 * is unreachable by apps. Category-level and wildcard grants are not expressible
 * here — Drive's all-access uses `fileAccessAll` instead.
 */
export const fileAccessSchema = z.object({
  extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
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
  auth: z.enum(["public", "jwt"]).default("jwt"),
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
  fileAccess: z.array(fileAccessSchema).default([]),
  // All-access over every extension + the `other` catch-all. Only the
  // `starkeep-drive` (User-Data-Owner) app may set this true; the validator
  // enforces that. Grants Drive the `shared/*` IAM ceiling. Installable apps
  // must enumerate extensions in `fileAccess` instead.
  fileAccessAll: z.boolean().default(false),
  compute: z
    .object({
      enabled: z.boolean().default(false),
      handlers: z.array(appComputeHandlerSchema).default([]),
    })
    .default({}),
  additionalResources: z.array(sharedResourceRequirementSchema).default([]),
  // sts:AssumeRole on ${StackPrefix}-app-* roles — only allowed for the cloud-data-server built-in app.
  brokerPower: z.boolean().default(false),
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
  // Install targets. Default ["local"] preserves prior behavior (every
  // discovered app appeared in the local list). A "cloud" app may be static
  // (S3/CloudFront, or just hitting cloud-data-server) or compute-backed.
  targets: z.array(appTargetSchema).default(["local"]),
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
export type AppTarget = z.infer<typeof appTargetSchema>;
export type FileAccess = z.infer<typeof fileAccessSchema>;
export type SharedResourceRequirement = z.infer<typeof sharedResourceRequirementSchema>;
export type AppComputeHandler = z.infer<typeof appComputeHandlerSchema>;
export type SyncableTableColumn = z.infer<typeof syncableTableColumnSchema>;
export type SyncableTable = z.infer<typeof syncableTableSchema>;
export type AppSpecificSyncable = z.infer<typeof appSpecificSyncableSchema>;
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type InfraRequirements = z.infer<typeof infraRequirementsSchema>;
export type AppManifest = z.infer<typeof appManifestSchema>;
