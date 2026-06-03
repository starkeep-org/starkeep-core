import type { HLCTimestamp } from "./types.js";

const SEPARATOR = ":";

export function serializeHLC(timestamp: HLCTimestamp): string {
  const wallTimeHex = timestamp.wallTime.toString(16).padStart(12, "0");
  const counterHex = timestamp.counter.toString(16).padStart(4, "0");
  return `${wallTimeHex}${SEPARATOR}${counterHex}${SEPARATOR}${timestamp.nodeId}`;
}

export function deserializeHLC(serializedString: string): HLCTimestamp {
  const parts = serializedString.split(SEPARATOR);
  if (parts.length !== 3) {
    throw new Error(`Invalid HLC timestamp string: ${serializedString}`);
  }
  return {
    wallTime: parseInt(parts[0], 16),
    counter: parseInt(parts[1], 16),
    nodeId: parts[2],
  };
}
