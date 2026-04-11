import * as v from "valibot";

const hlcTimestampSchema = v.object({
  wallTime: v.pipe(v.number(), v.integer(), v.minValue(0)),
  counter: v.pipe(v.number(), v.integer(), v.minValue(0)),
  nodeId: v.pipe(v.string(), v.minLength(1)),
});

const baseRecordSchema = v.object({
  id: v.pipe(v.string(), v.length(26)),
  type: v.pipe(v.string(), v.minLength(1)),
  createdAt: hlcTimestampSchema,
  updatedAt: hlcTimestampSchema,
  ownerId: v.pipe(v.string(), v.minLength(1)),
  syncStatus: v.picklist(["local", "synced", "pending_push", "pending_pull", "conflict"]),
  deletedAt: v.nullable(hlcTimestampSchema),
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const dataRecordSchema = v.object({
  ...baseRecordSchema.entries,
  kind: v.literal("data"),
  contentHash: v.nullable(v.string()),
  objectStorageKey: v.nullable(v.string()),
  mimeType: v.nullable(v.string()),
  sizeBytes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  content: v.record(v.string(), v.unknown()),
});

export const metadataRecordSchema = v.object({
  targetId: v.pipe(v.string(), v.length(26)),
  generatorId: v.pipe(v.string(), v.minLength(1)),
  generatorVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  inputHash: v.pipe(v.string(), v.minLength(1)),
  value: v.record(v.string(), v.unknown()),
});

export function validateDataRecord(data: unknown) {
  return v.safeParse(dataRecordSchema, data);
}

export function validateMetadataRecord(data: unknown) {
  return v.safeParse(metadataRecordSchema, data);
}
