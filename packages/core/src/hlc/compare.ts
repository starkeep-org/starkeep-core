import type { HLCTimestamp } from "./types.js";

/** Identity element for HLC ordering. Useful as a default watermark / "never seen". */
export const ZERO_HLC: HLCTimestamp = { wallTime: 0, counter: 0, nodeId: "" };

export function compareHLC(a: HLCTimestamp, b: HLCTimestamp): -1 | 0 | 1 {
  if (a.wallTime < b.wallTime) return -1;
  if (a.wallTime > b.wallTime) return 1;
  if (a.counter < b.counter) return -1;
  if (a.counter > b.counter) return 1;
  if (a.nodeId < b.nodeId) return -1;
  if (a.nodeId > b.nodeId) return 1;
  return 0;
}

export function maxHLC(a: HLCTimestamp, b: HLCTimestamp): HLCTimestamp {
  return compareHLC(a, b) >= 0 ? a : b;
}
