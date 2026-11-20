/**
 * Run now's wait: it ends on the run's outcome, and a run the platform
 * deferred because the cloud was busy is not a failure.
 */
import { describe, expect, it } from "vitest";
import type { JobState } from "@starkeep/app-client";
import { DEFERRED_POLL_MS, RUN_WAIT_MS, runAndWait } from "../src/browser/run-wait.js";

type LastRun = NonNullable<JobState["lastRun"]>;

function job(lastRun: Partial<LastRun> | null, running = false): JobState {
  return {
    name: "digest",
    running,
    lastRun: lastRun && {
      status: "ok",
      startedAt: null,
      finishedAt: null,
      message: null,
      ...lastRun,
    },
  } as JobState;
}

/** Fakes that answer `polls` in turn, after the first read answers `first`. */
function fakes(first: JobState, polls: JobState[]) {
  let clock = 0;
  const queued: string[] = [];
  const slept: number[] = [];
  const answers = [first, ...polls];
  return {
    queued,
    slept,
    deps: {
      listJobs: async () => [answers.length > 1 ? answers.shift()! : answers[0]!],
      runJobNow: async (name: string) => {
        queued.push(name);
        return "RUN1";
      },
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
      onPoll: () => {},
    },
  };
}

describe("runAndWait", () => {
  it("resolves when a run newer than the last one ends ok", async () => {
    const { deps, queued } = fakes(job({ startedAt: 1 }), [
      job({ startedAt: 1 }, true),
      job({ startedAt: 2, status: "ok" }),
    ]);
    await expect(runAndWait("digest", deps)).resolves.toBeUndefined();
    expect(queued).toEqual(["digest"]);
  });

  it("throws the run's message when the run fails", async () => {
    const { deps } = fakes(job(null), [job({ startedAt: 2, status: "failed", message: "boom" })]);
    await expect(runAndWait("digest", deps)).rejects.toThrow("the run ended failed: boom");
  });

  it("keeps waiting through a deferred run for the tick's run, and never queues again", async () => {
    const { deps, queued, slept } = fakes(job({ startedAt: 1 }), [
      job({ startedAt: 2, status: "deferred", message: "The cloud was busy." }),
      job({ startedAt: 2, status: "deferred" }),
      job({ startedAt: 3, status: "ok" }),
    ]);
    await expect(runAndWait("digest", deps)).resolves.toBeUndefined();
    expect(queued).toEqual(["digest"]);
    // After the deferral, the page polls slowly while it waits for the tick.
    expect(slept.slice(1)).toEqual([DEFERRED_POLL_MS, DEFERRED_POLL_MS]);
  });

  it("waits long enough for the platform's five-minute tick", () => {
    expect(RUN_WAIT_MS).toBeGreaterThan(5 * 60_000);
  });

  it("gives up after the wait, and says the cloud was busy when the run is deferred", async () => {
    const { deps } = fakes(job(null), [job({ startedAt: 2, status: "deferred" })]);
    await expect(runAndWait("digest", deps)).rejects.toThrow(
      "the cloud was busy, and the platform has not run the job yet",
    );
  });
});
