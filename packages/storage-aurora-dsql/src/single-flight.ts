/**
 * One statement at a time per client.
 *
 * `pg` 8 queues a query issued while the client is still running another, and
 * prints a deprecation warning the first time, with no stack. `pg` 9 throws
 * instead. A per-request adapter holds one client, so two code paths that
 * query it concurrently (a `Promise.all` over reads, say) depend on that
 * queue. They also interleave with any transaction the other path holds
 * open: a statement issued while `BEGIN` is open runs inside it.
 */

import type { DatabaseClient } from "./types.js";

/**
 * What a client does when a statement starts before the previous one settled.
 * `"throw"` refuses the statement, which is what tests want: the failure names
 * the overlapping call. `"warn"` logs `[pg-overlap]` with the stack once per
 * call site and lets `pg` queue the statement, so a missed site keeps working
 * in production.
 */
export type OverlapMode = "throw" | "warn";

export interface SingleFlightOptions {
  onOverlap: OverlapMode;
  /** Injectable for tests; defaults to `console.warn`. */
  warn?: (message: string) => void;
  /**
   * Called in `"throw"` mode with each refusal before it is thrown. A caller
   * that catches and logs its errors swallows the refusal, so a test suite
   * collects them here and asserts there were none.
   */
  onRefuse?: (error: Error) => void;
}

export function guardSingleFlight(
  client: DatabaseClient,
  options: SingleFlightOptions,
): DatabaseClient {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const warnedStacks = new Set<string>();
  let inFlight = 0;

  return {
    async query(text, values) {
      if (inFlight > 0) {
        const stack = new Error().stack?.split("\n").slice(2).join("\n") ?? "";
        const message = `a statement started while another was running on the same client: ${text.slice(0, 120)}`;
        if (options.onOverlap === "throw") {
          const error = new Error(`refused ${message}`);
          options.onRefuse?.(error);
          throw error;
        }
        if (!warnedStacks.has(stack)) {
          warnedStacks.add(stack);
          warn(`[pg-overlap] ${message}\n${stack}`);
        }
      }
      inFlight++;
      try {
        return await client.query(text, values);
      } finally {
        inFlight--;
      }
    },
    end: () => client.end(),
  };
}
