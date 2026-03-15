export type {
  StarkeepSdk,
  StarkeepSdkOptions,
  DataOperations,
  MetadataOperations,
  IndexOperations,
  AggregationOperations,
  SyncOperations,
  AccessControlOperations,
  ApiOperations,
} from "./types.js";

export { createStarkeepSdk } from "./sdk.js";

// Re-export commonly used types from core for convenience
export type {
  StarkeepId,
  DataRecord,
  MetadataRecord,
  HLCTimestamp,
  CreateDataRecordInput,
  CreateMetadataRecordInput,
} from "@starkeep/core";
