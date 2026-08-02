/**
 * The phone's work graph (item 14).
 *
 * These are policy assertions, not implementation ones. Each corresponds to a
 * decision that is cheap to get wrong and expensive to notice: a phone that
 * uploads over cellular, a phone that cannot evict because it is full, a phone
 * that never syncs because it is never plugged in. All three work fine on a dev
 * handset on a desk, which is precisely why they are asserted here rather than
 * discovered in use.
 */
import { describe, it, expect } from "vitest";
import {
  JOB_GRAPH,
  jobSpec,
  preferredOrder,
  runnableJobs,
  canRun,
  backoffMs,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  type DeviceState,
} from "../src/work/job-graph";

const device = (over: Partial<DeviceState> = {}): DeviceState => ({
  hasNetwork: true,
  isUnmetered: true,
  isCharging: true,
  isStorageLow: false,
  ...over,
});

describe("the four constraints", () => {
  // Constraint 1. A job that cannot be abandoned cannot be scheduled at all
  // under a model where the OS decides when the app stops.
  it("has no job that is unsafe to abandon", () => {
    for (const job of JOB_GRAPH) {
      expect(job.resumable, job.id).toBe(true);
    }
  });

  // Constraint 2. A unit that cannot finish inside its window never finishes,
  // so it retries forever and the phone makes no progress at all — which looks
  // identical to the app being broken.
  it("sizes every unit in seconds, not minutes", () => {
    for (const job of JOB_GRAPH) {
      expect(job.targetSecondsPerUnit, job.id).toBeLessThanOrEqual(10);
    }
  });

  // Constraint 3. A transfer the app performs itself dies when the app does,
  // which on a phone is constantly.
  it("delegates every large byte transfer to the OS", () => {
    expect(jobSpec("fetch-blobs").delegatedTransfer).toBe(true);
    expect(jobSpec("push-blobs").delegatedTransfer).toBe(true);
  });

  it("does not delegate work that is not a byte transfer", () => {
    // Handing a metadata exchange to a download manager would be nonsense; the
    // flag marks a real mechanism, not an aspiration.
    expect(jobSpec("sync-metadata").delegatedTransfer).toBe(false);
    expect(jobSpec("evict").delegatedTransfer).toBe(false);
  });
});

describe("network policy", () => {
  // A phone that uploads a 4 GB video over cellular has not done the user a
  // favour, however correct the transfer was — and a metered-data bill is harm
  // no retry logic undoes.
  it("moves bytes only on an unmetered connection", () => {
    expect(jobSpec("fetch-blobs").constraints.requiresUnmetered).toBe(true);
    expect(jobSpec("push-blobs").constraints.requiresUnmetered).toBe(true);
  });

  // Metadata is small, and the library staying browsable is worth a few
  // kilobytes — it is what makes elided records visible at all.
  it("exchanges metadata even on cellular", () => {
    expect(jobSpec("sync-metadata").constraints.requiresUnmetered).toBe(false);
    expect(jobSpec("sync-metadata").constraints.requiresNetwork).toBe(true);
  });

  // A phone in airplane mode must not forget what it shot.
  it("scans the camera roll with no network at all", () => {
    expect(jobSpec("scan-media-store").constraints.requiresNetwork).toBe(false);
  });
});

describe("battery policy", () => {
  // Derivation is the only genuinely CPU-hungry work here.
  it("derives only while charging", () => {
    expect(jobSpec("derive-ladder").constraints.requiresCharging).toBe(true);
  });

  // A phone that is never plugged in would otherwise never sync, which is
  // worse than a slightly emptier battery.
  it("does not require charging for anything else", () => {
    for (const job of JOB_GRAPH) {
      if (job.id === "derive-ladder") continue;
      expect(job.constraints.requiresCharging, job.id).toBe(false);
    }
  });
});

describe("storage policy", () => {
  // The deadlock this avoids: the phone fills up, and then cannot run the one
  // job that would empty it.
  it("lets eviction run even when storage is low", () => {
    expect(canRun(jobSpec("evict"), device({ isStorageLow: true }))).toBe(true);
  });

  it("stops everything else when storage is low", () => {
    const runnable = runnableJobs(device({ isStorageLow: true }));
    expect(runnable).toEqual(["evict"]);
  });
});

describe("ordering", () => {
  const order = preferredOrder();
  const before = (a: string, b: string) => order.indexOf(a as never) < order.indexOf(b as never);

  it("respects every declared dependency", () => {
    for (const job of JOB_GRAPH) {
      for (const dep of job.after) {
        expect(before(dep, job.id), `${dep} should precede ${job.id}`).toBe(true);
      }
    }
  });

  // Renditions before originals is the rule the whole storage design rests on;
  // pushing before deriving would send a 40 MB original where a 130 KB
  // rendition would have done.
  it("derives before it pushes", () => {
    expect(before("derive-ladder", "push-blobs")).toBe(true);
  });

  // Fetching before the metadata round is fetching against a stale idea of
  // what exists.
  it("syncs metadata before moving any bytes", () => {
    expect(before("sync-metadata", "fetch-blobs")).toBe(true);
    expect(before("sync-metadata", "push-blobs")).toBe(true);
  });

  // Eviction must know what is durable elsewhere before dropping anything.
  it("syncs metadata before evicting", () => {
    expect(before("sync-metadata", "evict")).toBe(true);
  });

  it("includes every job exactly once", () => {
    expect(order).toHaveLength(JOB_GRAPH.length);
    expect(new Set(order).size).toBe(JOB_GRAPH.length);
  });
});

describe("what runs under real conditions", () => {
  it("runs everything on wifi while charging", () => {
    expect(runnableJobs(device())).toHaveLength(JOB_GRAPH.length);
  });

  // The common case, and the one worth being sure about: a phone in a pocket on
  // cellular keeps the library browsable and moves no bytes.
  it("on cellular, off charge: metadata and local work only", () => {
    const runnable = runnableJobs(device({ isUnmetered: false, isCharging: false }));
    expect(runnable).toContain("sync-metadata");
    expect(runnable).toContain("scan-media-store");
    expect(runnable).not.toContain("fetch-blobs");
    expect(runnable).not.toContain("push-blobs");
    expect(runnable).not.toContain("derive-ladder");
  });

  // Offline is not idle. A phone in airplane mode can still notice what the
  // camera shot, derive renditions from it, and free space — and a design that
  // stopped all three would waste exactly the window (overnight, on charge,
  // no signal) that is best for the expensive work.
  it("offline: everything that touches nothing remote still runs", () => {
    const runnable = runnableJobs(device({ hasNetwork: false, isUnmetered: false }));
    expect(runnable).toContain("scan-media-store");
    expect(runnable).toContain("derive-ladder");
    expect(runnable).toContain("evict");
    // And nothing that does touch the network.
    expect(runnable).not.toContain("sync-metadata");
    expect(runnable).not.toContain("fetch-blobs");
    expect(runnable).not.toContain("push-blobs");
  });

  it("offline and off charge does not derive", () => {
    // Derivation is gated on charging rather than on connectivity, so this is
    // the battery rule showing through rather than the network one.
    expect(
      runnableJobs(device({ hasNetwork: false, isUnmetered: false, isCharging: false })),
    ).not.toContain("derive-ladder");
  });
});

describe("backoff", () => {
  it("grows with each attempt", () => {
    expect(backoffMs(1)).toBe(MIN_BACKOFF_MS);
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
    expect(backoffMs(3)).toBeGreaterThan(backoffMs(2));
  });

  // The cap matters more than the curve. Uncapped, a phone offline for a week
  // comes back with a retry delay measured in days — so the first thing it does
  // on regaining connectivity is nothing.
  it("is capped, so a long outage does not become a longer silence", () => {
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  it("does not delay a first attempt", () => {
    expect(backoffMs(0)).toBe(0);
  });
});
