export type {
  StarkeepSdk,
  StarkeepSdkOptions,
  DataOperations,
  IndexOperations,
  ApiOperations,
} from "./types.js";

export { createStarkeepSdk } from "./sdk.js";

// Re-export commonly used types from core for convenience
export type {
  StarkeepId,
  DataRecord,
  HLCTimestamp,
  CreateDataRecordInput,
} from "@starkeep/protocol-primitives";
