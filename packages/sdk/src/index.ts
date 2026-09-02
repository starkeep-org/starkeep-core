export type {
  StarkeepSdk,
  StarkeepSdkOptions,
  DataOperations,
  IndexOperations,
  ApiOperations,
} from "./types.js";

export { createStarkeepSdk } from "./sdk.js";

// `createNodeClock` is public because `StarkeepSdkOptions.clock` is. A caller
// that supplies its own clock has to build it correctly — one instance per node
// id, seeded from persisted state — and without this export the only way to get
// a clock is `createHLCClock`, which builds a second unpersisted one under the
// same identity. That is the exact defect the option exists to avoid.
export { createNodeClock, type NodeClock } from "./sdk.js";

// Re-export commonly used types from core for convenience
export type {
  StarkeepId,
  DataRecord,
  HLCTimestamp,
  CreateDataRecordInput,
} from "@starkeep/protocol-primitives";
