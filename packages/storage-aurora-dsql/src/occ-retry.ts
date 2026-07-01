/**
 * Optimistic-concurrency retry for the Aurora DSQL data plane.
 *
 * DSQL's storage is OCC-controlled: a statement or transaction that raced a
 * concurrent writer fails at COMMIT with the `OC*` SQLSTATE family (e.g.
 * `OC000`/`OC001`) — surfaced by the pg driver as an error whose `code` starts
 * with "OC", sometimes only as a message like "change conflicts with another
 * transaction". AWS's guidance for this class is simply to retry the
 * transaction. Retrying is only safe when the replayed unit is idempotent, so
 * callers must wrap an idempotent unit of work (see the plan / call sites).
 *
 * This mirrors `isRetryableDsqlConflict` in
 * admin-installer/src/retry-on-access-denied.ts (the control-plane copy). The
 * data plane keeps its own copy here because the CDS Lambda artifact bundles
 * `@starkeep/*` packages but cannot import the installer package at runtime.
 * The backoff budget is deliberately short — OCC conflicts clear in
 * milliseconds, unlike the installer's minutes-long IAM-propagation window.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export function isRetryableDsqlConflict(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? "";
  const message = (e?.message ?? "").toLowerCase();
  if (code.startsWith("OC")) return true; // DSQL OCC conflict family (e.g. OC000/OC001)
  if (message.includes("updated by another transaction")) return true;
  if (message.includes("change conflicts with another transaction")) return true;
  return false;
}

export interface OccRetryOpts {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Marks that we are already inside a retry loop for the current async context.
// The OUTERMOST withOccRetry owns the retry; nested calls run their body once
// and let the conflict propagate to the outer loop. This makes a read-modify-
// write unit (outer) that internally calls a self-retrying adapter method
// (inner) re-read on conflict instead of the inner write clobbering the
// concurrent winner. AsyncLocalStorage scopes the flag per request so
// concurrent invocations don't see each other's state.
const inRetryUnit = new AsyncLocalStorage<boolean>();

/**
 * Run `fn`, retrying only on DSQL OCC conflicts with exponential backoff.
 * `fn` MUST be idempotent — it is replayed verbatim on each conflict. Any
 * non-OCC error propagates immediately (no retry). After the attempt budget is
 * exhausted the last conflict is rethrown.
 *
 * Re-entrant: when already inside an enclosing withOccRetry (same async
 * context), `fn` runs exactly once and any OCC conflict bubbles to the outer
 * loop, which re-runs the whole enclosing unit.
 */
export async function withOccRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: OccRetryOpts = {},
): Promise<T> {
  // Nested call: defer retrying to the outer loop so it can re-read.
  if (inRetryUnit.getStore()) {
    return fn();
  }

  const maxAttempts = opts.maxAttempts ?? 6;
  const maxDelayMs = opts.maxDelayMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  let delay = opts.initialDelayMs ?? 25;

  return inRetryUnit.run(true, async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isRetryableDsqlConflict(err) || attempt === maxAttempts) {
          throw err;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, maxDelayMs);
      }
    }
    // Unreachable: the loop either returns or throws on the final attempt.
    throw new Error(`unreachable: withOccRetry(${label})`);
  });
}
