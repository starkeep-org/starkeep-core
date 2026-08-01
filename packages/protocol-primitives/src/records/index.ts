export {
  type BaseRecord,
  type DataRecord,
  type MetadataRow,
  type AnyRecord,
} from "./types.js";
export {
  createDataRecord,
  type CreateDataRecordInput,
} from "./builders.js";
export {
  type RecordLabel,
  type LabelRef,
  type LabelWriteRequest,
  type LabelRetractRequest,
  type PlannedLabelWrite,
  type LabelPlan,
  planLabelWrites,
  planLabelRetractions,
  dedupeLabelWrites,
  LABEL_KEY_MAX_LENGTH,
  LABEL_KEYS_PER_APP_MAX,
  LABEL_VALUE_MAX_BYTES,
  LABEL_VALUES_PER_KEY_MAX,
  isValidLabelKey,
  isValidLabelValue,
  labelValueSetKey,
  labelValueByteLength,
  validateLabelWrite,
  formatLabelRef,
  parseLabelRef,
} from "./labels.js";
export {
  resolveVariant,
  resolveVariants,
  parseVariantLongEdges,
  MAX_VARIANT_TARGETS,
  type VariantCandidate,
  type ResolvedVariant,
} from "./variants.js";
