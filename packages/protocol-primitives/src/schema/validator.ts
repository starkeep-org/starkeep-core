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
  deletedAt: v.nullable(hlcTimestampSchema),
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const dataRecordSchema = v.object({
  ...baseRecordSchema.entries,
  kind: v.literal("data"),
  contentHash: v.pipe(v.string(), v.minLength(1)),
  objectStorageKey: v.pipe(v.string(), v.minLength(1)),
  mimeType: v.pipe(v.string(), v.minLength(1)),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  originalFilename: v.nullable(v.string()),
  originAppId: v.pipe(v.string(), v.minLength(1)),
  parentId: v.nullable(v.string()),
  label: v.nullable(v.string()),
});

export function validateDataRecord(data: unknown) {
  return v.safeParse(dataRecordSchema, data);
}
