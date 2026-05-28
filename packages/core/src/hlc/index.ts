export type { HLCTimestamp, HLCClock } from "./types.js";
export { createHLCClock } from "./clock.js";
export type { ClockOptions } from "./clock.js";
export { compareHLC, maxHLC, ZERO_HLC } from "./compare.js";
export { serializeHLC, deserializeHLC } from "./serialize.js";
