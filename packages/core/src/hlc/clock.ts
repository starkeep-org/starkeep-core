import type { HLCClock, HLCTimestamp } from "./types.js";

export interface ClockOptions {
  nodeId: string;
  wallClockFunction?: () => number;
}

export function createHLCClock(options: ClockOptions): HLCClock {
  const { nodeId, wallClockFunction = Date.now } = options;

  let lastWallTime = 0;
  let lastCounter = 0;

  function now(): HLCTimestamp {
    const physicalTime = wallClockFunction();
    if (physicalTime > lastWallTime) {
      lastWallTime = physicalTime;
      lastCounter = 0;
    } else {
      lastCounter++;
    }
    return { wallTime: lastWallTime, counter: lastCounter, nodeId };
  }

  function send(): HLCTimestamp {
    return now();
  }

  function receive(remote: HLCTimestamp): HLCTimestamp {
    const physicalTime = wallClockFunction();
    if (physicalTime > lastWallTime && physicalTime > remote.wallTime) {
      lastWallTime = physicalTime;
      lastCounter = 0;
    } else if (remote.wallTime > lastWallTime) {
      lastWallTime = remote.wallTime;
      lastCounter = remote.counter + 1;
    } else if (lastWallTime === remote.wallTime) {
      lastCounter = Math.max(lastCounter, remote.counter) + 1;
    } else {
      lastCounter++;
    }
    return { wallTime: lastWallTime, counter: lastCounter, nodeId };
  }

  return { now, send, receive };
}
