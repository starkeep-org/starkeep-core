import type { HLCClock, HLCTimestamp } from "./types.js";

export interface ClockState {
  wallTime: number;
  counter: number;
}

export interface ClockOptions {
  nodeId: string;
  wallClockFunction?: () => number;
  /**
   * Pre-seed the clock from persisted state so a post-restart HLC never
   * emits a timestamp earlier than one the node already sent.
   */
  initialState?: ClockState;
  /**
   * Invoked on every state change. Callers typically debounce and persist
   * to a SyncStateStore.
   */
  onTick?: (state: ClockState) => void;
}

export function createHLCClock(options: ClockOptions): HLCClock {
  const { nodeId, wallClockFunction = Date.now, initialState, onTick } = options;

  let lastWallTime = initialState?.wallTime ?? 0;
  let lastCounter = initialState?.counter ?? 0;

  function emit(): void {
    if (onTick) onTick({ wallTime: lastWallTime, counter: lastCounter });
  }

  function now(): HLCTimestamp {
    const physicalTime = wallClockFunction();
    if (physicalTime > lastWallTime) {
      lastWallTime = physicalTime;
      lastCounter = 0;
    } else {
      lastCounter++;
    }
    emit();
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
    emit();
    return { wallTime: lastWallTime, counter: lastCounter, nodeId };
  }

  return { now, send, receive };
}
