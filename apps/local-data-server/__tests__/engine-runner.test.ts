/**
 * The per-engine serialization the supervisor depends on.
 *
 * Tested here rather than through the server because the property is about
 * *overlap*, and overlap is exactly what an end-to-end test cannot force
 * deterministically. What went wrong was invisible for the same reason: the
 * supervisor's tick moved from one `exchange()` to a whole `sync()` drain, and
 * nothing in the suite could observe two of them running against one engine's
 * watermark rows at the same time.
 */

import { describe, it, expect } from "vitest";
import { createEngineRunner } from "../engine-runner.js";

/** A body that reports whether it was ever entered while already inside. */
function overlapDetector() {
  let inside = 0;
  let overlapped = false;
  let completions = 0;
  return {
    get overlapped() {
      return overlapped;
    },
    get completions() {
      return completions;
    },
    async body(delayMs = 0): Promise<void> {
      inside += 1;
      if (inside > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inside -= 1;
      completions += 1;
    },
  };
}

const never = () => false;

describe("run — exclusive access", () => {
  it("does not let two operations overlap", async () => {
    const runner = createEngineRunner({ cancelled: never });
    const detector = overlapDetector();

    await Promise.all([
      runner.run(() => detector.body(20)),
      runner.run(() => detector.body(5)),
      runner.run(() => detector.body(0)),
    ]);

    expect(detector.overlapped).toBe(false);
    expect(detector.completions).toBe(3);
  });

  it("runs them in the order they were asked for", async () => {
    const runner = createEngineRunner({ cancelled: never });
    const order: number[] = [];
    await Promise.all(
      [30, 10, 0].map((delay, index) =>
        runner.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          order.push(index);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2]);
  });

  it("hands the queue on after a rejection instead of wedging", async () => {
    // One failed exchange must not stop every later one on that engine.
    const runner = createEngineRunner({ cancelled: never });
    const failure = runner.run(async () => {
      throw new Error("exchange failed");
    });
    await expect(failure).rejects.toThrow("exchange failed");

    let ran = false;
    await runner.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("surfaces a rejection to its own caller only", async () => {
    const runner = createEngineRunner({ cancelled: never });
    const results = await Promise.allSettled([
      runner.run(async () => {
        throw new Error("boom");
      }),
      runner.run(async () => "fine"),
    ]);
    expect(results[0]!.status).toBe("rejected");
    expect(results[1]).toEqual({ status: "fulfilled", value: "fine" });
  });
});

describe("drain — coalescing", () => {
  it("folds a second request into the drain already running", async () => {
    const runner = createEngineRunner({ cancelled: never });
    const detector = overlapDetector();

    const first = runner.drain(() => detector.body(20));
    // Let the first drain get inside its body before asking again.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runner.drain(() => detector.body(0));

    expect(second).toBe(false); // folded in, did not own a drain
    expect(await first).toBe(true);
    expect(detector.overlapped).toBe(false);
    // Two passes: the original, plus one rerun covering the folded request.
    expect(detector.completions).toBe(2);
  });

  it("collapses many requests into a single rerun", async () => {
    // A burst of local writes must not schedule one full drain each.
    const runner = createEngineRunner({ cancelled: never });
    const detector = overlapDetector();

    const first = runner.drain(() => detector.body(20));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all([
      runner.drain(() => detector.body(0)),
      runner.drain(() => detector.body(0)),
      runner.drain(() => detector.body(0)),
      runner.drain(() => detector.body(0)),
    ]);
    await first;

    expect(detector.completions).toBe(2);
  });

  it("abandons the rerun when cancelled", async () => {
    // `/sync/pause` has to stop a coalesced rerun, not just a fresh drain.
    let paused = false;
    const runner = createEngineRunner({ cancelled: () => paused });
    const detector = overlapDetector();

    const first = runner.drain(() => detector.body(20));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.drain(() => detector.body(0));
    paused = true;
    await first;

    expect(detector.completions).toBe(1);
  });

  it("reports draining only while a drain is in progress", async () => {
    const runner = createEngineRunner({ cancelled: never });
    expect(runner.draining).toBe(false);
    const inFlight = runner.drain(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(runner.draining).toBe(true);
    await inFlight;
    expect(runner.draining).toBe(false);
  });

  it("starts a fresh drain once the previous one has finished", async () => {
    const runner = createEngineRunner({ cancelled: never });
    const detector = overlapDetector();
    expect(await runner.drain(() => detector.body(0))).toBe(true);
    expect(await runner.drain(() => detector.body(0))).toBe(true);
    expect(detector.completions).toBe(2);
  });

  it("keeps a drain and an ordinary operation from overlapping", async () => {
    // The case that matters: a tick drain in flight when /sync/verify arrives.
    // verify() writes repair floors; a round writes them too.
    const runner = createEngineRunner({ cancelled: never });
    const detector = overlapDetector();

    const drain = runner.drain(() => detector.body(20));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.run(() => detector.body(0));
    await drain;

    expect(detector.overlapped).toBe(false);
  });

  it("does not wedge the drain loop when a pass throws", async () => {
    const runner = createEngineRunner({ cancelled: never });
    let calls = 0;
    await expect(
      runner.drain(async () => {
        calls += 1;
        throw new Error("exchange failed");
      }),
    ).rejects.toThrow("exchange failed");

    expect(runner.draining).toBe(false);
    await runner.drain(async () => {
      calls += 1;
    });
    expect(calls).toBe(2);
  });
});
