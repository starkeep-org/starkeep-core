/**
 * The request gate: no more than `maxInFlight` requests at once, and throttled
 * requests sent again while other failures are not.
 *
 * Without the gate, a refresh of every panel sent about fifteen requests at
 * once. In the cloud each one holds two Lambda executions, so the account's
 * concurrency limit throttled most of them and the page failed to load.
 */
import { describe, expect, it } from "vitest";
import { createRequestGate, isThrottle } from "../src/browser/request-gate.js";

/** A promise and the function that settles it, for holding an attempt open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let every queued microtask and promise callback run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const noWait = { sleep: async () => {}, random: () => 0.5 };

describe("the in-flight limit", () => {
  it("never runs more than maxInFlight attempts at once, and runs them all", async () => {
    const gate = createRequestGate({ maxInFlight: 3, retryDelaysMs: [], ...noWait });
    let running = 0;
    let peak = 0;
    const holds = Array.from({ length: 15 }, () => deferred<void>());

    const sends = holds.map((hold) =>
      gate.send(async () => {
        running++;
        peak = Math.max(peak, running);
        await hold.promise;
        running--;
        return { status: 200 };
      }),
    );

    await flush();
    expect(running).toBe(3);
    for (const hold of holds) {
      hold.resolve();
      await flush();
    }
    const results = await Promise.all(sends);
    expect(peak).toBe(3);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it("starts waiting requests in the order they arrived", async () => {
    const gate = createRequestGate({ maxInFlight: 1, retryDelaysMs: [], ...noWait });
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        gate.send(async () => {
          order.push(n);
          await flush();
          return { status: 200 };
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("frees the slot when an attempt rejects, and does not retry it", async () => {
    const gate = createRequestGate({ maxInFlight: 1, retryDelaysMs: [10], ...noWait });
    let calls = 0;
    await expect(
      gate.send(async () => {
        calls++;
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow("Failed to fetch");
    expect(calls).toBe(1);
    await expect(gate.send(async () => ({ status: 200 }))).resolves.toEqual({ status: 200 });
  });
});

describe("retrying throttled requests", () => {
  it("sends a throttled request again until it succeeds, waiting a jittered delay each time", async () => {
    const waits: number[] = [];
    const gate = createRequestGate({
      maxInFlight: 1,
      retryDelaysMs: [300, 1000, 3000],
      sleep: async (ms) => void waits.push(ms),
      random: () => 0, // the low end of the jitter: half of each delay
    });
    const statuses = [503, 429, 200];
    const result = await gate.send(async () => ({ status: statuses.shift()! }));
    expect(result.status).toBe(200);
    expect(waits).toEqual([150, 500]);
  });

  it("answers the last throttle once the retries run out", async () => {
    const gate = createRequestGate({ maxInFlight: 1, retryDelaysMs: [1, 1], ...noWait });
    let calls = 0;
    const result = await gate.send(async () => {
      calls++;
      return { status: 503 };
    });
    expect(result.status).toBe(503);
    expect(calls).toBe(3);
  });

  it("never retries a failure that can follow work already done", async () => {
    // A 500 or 502 can follow a crash partway through a write, and a 504 a
    // timeout after it. Sending the request again could write twice.
    const gate = createRequestGate({ maxInFlight: 1, retryDelaysMs: [1, 1], ...noWait });
    for (const status of [500, 502, 504]) {
      let calls = 0;
      const result = await gate.send(async () => {
        calls++;
        return { status };
      });
      expect(result.status, String(status)).toBe(status);
      expect(calls, String(status)).toBe(1);
    }
  });

  it("does not retry client errors", async () => {
    const gate = createRequestGate({ maxInFlight: 1, retryDelaysMs: [1, 1], ...noWait });
    for (const status of [400, 401, 403, 404, 409]) {
      let calls = 0;
      await gate.send(async () => {
        calls++;
        return { status };
      });
      expect(calls, String(status)).toBe(1);
    }
  });

  it("holds the slot through the retry wait", async () => {
    const wait = deferred<void>();
    const gate = createRequestGate({
      maxInFlight: 1,
      retryDelaysMs: [100],
      sleep: () => wait.promise,
      random: () => 0.5,
    });
    const statuses = [503, 200];
    const first = gate.send(async () => ({ status: statuses.shift()! }));
    let secondRan = false;
    const second = gate.send(async () => {
      secondRan = true;
      return { status: 200 };
    });
    await flush();
    expect(secondRan).toBe(false);
    wait.resolve();
    await Promise.all([first, second]);
    expect(secondRan).toBe(true);
  });
});

describe("isThrottle", () => {
  it("covers 503 and 429 only", () => {
    expect(isThrottle(503)).toBe(true);
    expect(isThrottle(429)).toBe(true);
    for (const status of [200, 400, 500, 502, 504]) expect(isThrottle(status)).toBe(false);
  });
});
