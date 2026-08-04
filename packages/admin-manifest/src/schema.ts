import { z } from "zod";

export const appTierSchema = z.enum(["official", "verified", "community"]);

// Where an app can be installed. An app may target local, cloud, or both. The
// admin Dashboard derives its Local / Cloud lists from this field.
export const appTargetSchema = z.enum(["local", "cloud"]);

/**
 * An app's grant over a set of canonical Starkeep types. Installable apps
 * enumerate the exact `<category>/<format>` type ids they handle (e.g.
 * "image/jpeg"). Validation rejects any id not in the platform registry, so the
 * unmapped (`other/*`) set is unreachable by apps. Category-level and wildcard
 * grants are not expressible here — Drive's all-access uses `fileAccessAll`.
 */
export const fileAccessSchema = z.object({
  types: z.array(z.string().regex(/^[a-z0-9]+\/[a-z0-9]+$/)).min(1),
  access: z.enum(["read", "readwrite"]),
  metadataWrite: z.boolean().default(false),
  rationale: z.string(),
});

/**
 * One label key this app publishes into the shared plane, e.g.
 * `{ key: "ocr-available", description: "This app holds OCR text for the record" }`.
 *
 * Keys are declared rather than counted at runtime because **discoverability is
 * the reason to pay for a manifest declaration**: app B's developer can see
 * what app A publishes without reading app A's source. The registry is
 * therefore readable cross-app (`GET /data/label-keys`), which is what makes
 * the declaration worth more than a runtime counter would be.
 *
 * The write path rejects any key not declared here, so the cap on *distinct
 * keys* is what stops an app using keys as data — a bounded key space is the
 * thing that makes a key schema rather than content.
 *
 * `description` is carried into the registry so the cross-app enumeration is
 * self-explaining rather than a list of bare strings.
 */
export const labelKeySchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  description: z.string().min(1),
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

// `handler` is the Lambda entry point inside the app's `dist.zip` (e.g.
// `index.handler` or `infra/src/resize-handler.handler`). The app's
// `pnpm bundle` script is responsible for producing a zip whose contents
// resolve this path — the installer does not synthesize handler code.
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

export const syncableTableSchema = z
  .object({
    // Becomes "<appId>_syncable_<name>" in the local SQLite schema.
    name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
    columns: z.array(syncableTableColumnSchema).min(1),
  })
  // A syncable table without a primary key is not a table the sync protocol can
  // carry, and the failure is silent and compounding rather than loud. With no
  // key there is no conflict target, so the applier's `ON CONFLICT DO NOTHING`
  // has nothing to conflict on and every replay of the same wire entry inserts
  // another row — and a repair round, a re-ship after a lost response and a
  // watermark reset are all replays. The duplicates then make the two sides'
  // bucket counts disagree permanently, `verify()` reports divergence, the
  // repair re-ships, and the re-ship duplicates again.
  //
  // Deletes cannot propagate either: a tombstone has to name the row it
  // retracts, `rowToWireEntry` correctly refuses to emit a keyless one (the
  // alternative wiped the peer's table), so the deletion stays on the node that
  // made it forever.
  //
  // Refused here rather than handled downstream because this is the only place
  // that can make it *unrepresentable*. Every consumer below — the SQLite and
  // DSQL DDL, both appliers, `rowToWireEntry` — has a branch for the keyless
  // case, and none of them can do anything useful in it.
  .refine((table) => table.columns.some((c) => c.primaryKey), {
    message:
      `A syncable table must declare at least one column with "primaryKey": true. ` +
      `Without one the row has no identity: replays duplicate it and deletions ` +
      `never leave the node that made them.`,
  });

export const appSpecificSyncableSchema = z.object({
  tables: z.array(syncableTableSchema).default([]),
  // Opt-in for apps/<appId>/syncable/ object-storage prefix. App-specific
  // (private) data is not necessarily file-backed — apps with row-only
  // app-specific data leave this false. (Shared data is always file-backed
  // and is not controlled by this flag.)
  files: z.boolean().default(false),
});

export const infraRequirementsSchema = z.object({
  fileAccess: z.array(fileAccessSchema).default([]),
  // All-access over every type + the `other` catch-all. Only the
  // `starkeep-drive` (User-Data-Owner) app may set this true; the validator
  // enforces that. Grants Drive the `shared/*` IAM ceiling. Installable apps
  // must enumerate types in `fileAccess` instead.
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
  /**
   * Label keys this app may write into `shared.record_labels`. Capped at 64 —
   * the cardinality cap is the one that actually enforces the intent, since
   * byte caps alone leave an unbounded key space to smuggle content through.
   * The uniqueness check lives in validate.ts alongside the other cross-field
   * rules.
   */
  labelKeys: z.array(labelKeySchema).max(64).default([]),
});

export const permissionEntrySchema = z.object({
  subjectType: z.literal("app"),
  resourceType: z.enum(["type", "collection", "wildcard"]),
  resourceId: z.string().min(1),
  permissions: z.array(z.enum(["read", "write", "delete", "admin"])),
  rationale: z.string(),
});

// How admin-web should spawn this app's local dev/serve process. Optional —
// apps without a localRun block cannot be started from the admin UI. When
// `portFlag` is set, admin-web allocates a free TCP port at start time and
// appends `[portFlag, <port>]` to args; apps that pick their own port omit it.
export const localRunSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  portFlag: z.string().optional(),
  // Working directory relative to the manifest's directory. Defaults to ".".
  cwd: z.string().default("."),
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
  localRun: localRunSchema.optional(),
  homepage: z.string().url().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
});

export type AppTier = z.infer<typeof appTierSchema>;
export type AppTarget = z.infer<typeof appTargetSchema>;
export type FileAccess = z.infer<typeof fileAccessSchema>;
export type LabelKey = z.infer<typeof labelKeySchema>;
export type SharedResourceRequirement = z.infer<typeof sharedResourceRequirementSchema>;
export type AppComputeHandler = z.infer<typeof appComputeHandlerSchema>;
export type SyncableTableColumn = z.infer<typeof syncableTableColumnSchema>;
export type SyncableTable = z.infer<typeof syncableTableSchema>;
export type AppSpecificSyncable = z.infer<typeof appSpecificSyncableSchema>;
export type LocalRun = z.infer<typeof localRunSchema>;
export type PermissionEntry = z.infer<typeof permissionEntrySchema>;
export type InfraRequirements = z.infer<typeof infraRequirementsSchema>;
export type AppManifest = z.infer<typeof appManifestSchema>;
