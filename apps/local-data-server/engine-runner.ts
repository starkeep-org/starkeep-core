/**
 * One engine, one operation at a time.
 *
 * ## Why a sync engine needs this
 *
 * `syncState` is read-modify-write throughout and has no compare-and-set: a
 * round loads the watermarks, the repair floors and the inbound floors, works
 * out where they should be, and writes them back. That is safe exactly as long
 * as nothing else is doing it at the same time.
 *
 * It stopped being safe when a supervisor tick went from running a single
 * `exchange()` to running a whole `sync()` drain. A drain over a first sync is
 * minutes of wall clock, and a nudge, a `kick()`, a `/sync/now` or a
 * `/sync/verify` arriving inside that window started a second one against the
 * same rows. Two rounds then compute positions from the same snapshot and the
 * later write wins: a watermark can go backwards (survivable — it costs a
 * re-ship) and a repair floor can be dropped (not survivable — it is the only
 * record that a hole still needs filling, so the repair reports success and
 * does nothing).
 *
 * ## Coalescing, not queueing
 *
 * {@link EngineRunner.drain} folds a request into a drain already running
 * rather than lining another one up behind it. A nudge means "there are local
 * writes to push", and the running drain's next round will see them — it
 * re-scans from the watermark every round, it does not work from a snapshot
 * taken at the start. Queueing one drain per nudge would instead schedule N
 * identical passes over the same backlog.
 *
 * The one case that needs care is a request arriving *after* the running drain
 * has passed the point where it would have seen the write. That is what
 * `rerunRequested` is for: one more pass after the current one finishes,
 * however many requests folded in.
 */

export interface EngineRunner {
  /**
   * Run `body` with exclusive use of the engine, once everything queued ahead
   * of it has finished. Rejections propagate to the caller and do not wedge the
   * queue for anyone else.
   */
  run<T>(body: () => Promise<T>): Promise<T>;
  /**
   * Run `body` as a drain, folding into one already in progress.
   *
   * Resolves `true` when this call actually owned the drain (and therefore
   * finished it), `false` when it folded into a running one and returned
   * immediately. Callers use that to decide who reschedules the idle timer —
   * a folded-in caller must not, or the timer restarts while work is still
   * running.
   */
  drain(body: () => Promise<void>): Promise<boolean>;
  /** Whether a drain is in progress right now. */
  readonly draining: boolean;
}

export interface EngineRunnerOptions {
  /**
   * Checked before each rerun. Returning true abandons the follow-up pass —
   * the supervisor's pause, so `/sync/pause` stops a coalesced rerun as well
   * as a fresh one.
   */
  readonly cancelled: () => boolean;
}

export function createEngineRunner(options: EngineRunnerOptions): EngineRunner {
  let lock: Promise<unknown> = Promise.resolve();
  let draining = false;
  let rerunRequested = false;

  function run<T>(body: () => Promise<T>): Promise<T> {
    // `then(body, body)` rather than `then(body)`: a rejected predecessor must
    // still hand the queue on, or one failed exchange wedges the engine.
    const next = lock.then(body, body);
    lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function drain(body: () => Promise<void>): Promise<boolean> {
    if (draining) {
      rerunRequested = true;
      return false;
    }
    draining = true;
    try {
      do {
        rerunRequested = false;
        await run(body);
      } while (rerunRequested && !options.cancelled());
    } finally {
      draining = false;
    }
    return true;
  }

  return {
    run,
    drain,
    get draining() {
      return draining;
    },
  };
}
