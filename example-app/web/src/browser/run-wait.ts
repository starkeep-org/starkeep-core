/**
 * Run now, and wait for the run to finish.
 *
 * The page queues one run, then polls the app's jobs until a run newer than
 * the last one finishes. When the cloud is too busy to start the run, the
 * platform records it as `deferred` and runs it on its next tick, within five
 * minutes. A deferred run is not a failure, so the page keeps waiting for the
 * tick's run. It never queues the run again: the deferred run stays due, and a
 * second request would make the job run twice.
 */

import type { JobState } from "@starkeep/app-client";

/** How often the page polls while a run is queued or running. */
export const RUN_POLL_MS = 2_000;

/** How often the page polls while it waits for the platform's next tick. */
export const DEFERRED_POLL_MS = 10_000;

/**
 * How long Run now waits before it leaves the rest to Refresh jobs: the
 * platform's five-minute tick after a deferred run, plus the run itself.
 */
export const RUN_WAIT_MS = 420_000;

export interface RunWaitDeps<J extends JobState> {
  listJobs(): Promise<J[]>;
  /** Queue one run. Throws on a refusal, such as `not-enabled`. */
  runJobNow(name: string): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Each poll's jobs, so the page can redraw its table. */
  onPoll(jobs: J[]): void;
}

/** Queue one run of `name`, and resolve when it ends `ok`. Throws when it fails or takes too long. */
export async function runAndWait<J extends JobState>(
  name: string,
  deps: RunWaitDeps<J>,
): Promise<void> {
  // Read the last run now, not from the table: a scheduled run may have
  // finished since the table was drawn.
  const current = (await deps.listJobs()).find((j) => j.name === name);
  const before = current?.lastRun?.startedAt ?? null;
  await deps.runJobNow(name);
  const deadline = deps.now() + RUN_WAIT_MS;
  let deferred = false;
  for (;;) {
    await deps.sleep(deferred ? DEFERRED_POLL_MS : RUN_POLL_MS);
    const jobs = await deps.listJobs();
    deps.onPoll(jobs);
    const state = jobs.find((j) => j.name === name);
    const last = state?.lastRun;
    if (state && !state.running && last && last.startedAt !== before) {
      deferred = last.status === "deferred";
      if (last.status === "ok") return;
      if (!deferred) throw new Error(`the run ended ${last.status}: ${last.message ?? ""}`);
    }
    if (deps.now() > deadline) {
      throw new Error(
        deferred
          ? "the cloud was busy, and the platform has not run the job yet; use Refresh jobs"
          : "the run has not finished yet; use Refresh jobs",
      );
    }
  }
}
