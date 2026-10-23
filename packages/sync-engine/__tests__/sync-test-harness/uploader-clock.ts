import type { SyncEngine, UploaderTimers } from "../../src/index.js";

/**
 * A clock for the uploader that moves only when a test says so.
 *
 * The uploader backs off 30 seconds after a failure and pauses 30 seconds after
 * an outage. A test that retries in its next round advances this clock past
 * both, so a round means what it meant when uploads ran inside it. Timers
 * longer than a second never fire: they are backoff and backstop wakes, which
 * a test drives by advancing the clock and draining again.
 */
export interface TestUploaderClock extends UploaderTimers {
  advance(ms: number): void;
}

export function createTestUploaderClock(start = 1_000_000): TestUploaderClock {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    setTimeout: (callback, ms) => (ms > 1000 ? null : globalThis.setTimeout(callback, ms)),
    clearTimeout: (handle) => {
      if (handle !== null) globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

/** Longer than every backoff and pause, so whatever failed is due again. */
export const PAST_EVERY_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Upload what the last exchange made owed, then let time pass so a file that
 * failed is due again by the next round.
 */
export async function uploadAfterRound(
  engine: SyncEngine,
  clock: TestUploaderClock,
): Promise<void> {
  await engine.uploader.drain();
  clock.advance(PAST_EVERY_BACKOFF_MS);
}

const clocks = new WeakMap<object, TestUploaderClock>();

/** One clock per owner — a side, a store — so every engine over it agrees on time. */
export function uploaderClockFor(owner: object): TestUploaderClock {
  let clock = clocks.get(owner);
  if (!clock) {
    clock = createTestUploaderClock();
    clocks.set(owner, clock);
  }
  return clock;
}
