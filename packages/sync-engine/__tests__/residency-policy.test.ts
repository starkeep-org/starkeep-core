import { describe, it, expect } from "vitest";
import {
  decideResidency,
  validateRetentionPolicy,
  type BlobCandidate,
  type NodeRetentionPolicy,
  type SizeClassRetention,
} from "../src/residency-policy.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 1);

// Class names here are deliberately nonsense. The platform must never learn
// what `image-medium` is, and a test that used real ladder names would quietly
// encode the opposite assumption.
const row = (over: Partial<SizeClassRetention> = {}): SizeClassRetention => ({
  keep: "all",
  budgetBytes: 1_000_000,
  ...over,
});

const policy = (rows: Record<string, SizeClassRetention>): NodeRetentionPolicy => ({
  rows,
  fallback: row(),
});

const candidate = (over: Partial<BlobCandidate> = {}): BlobCandidate => ({
  recordId: "r1",
  objectStorageKey: "shared/image/aa/" + "a".repeat(64),
  sizeBytes: 1000,
  type: "image/jpeg",
  parentId: null,
  appId: null,
  recencyAtMs: NOW,
  lastOpenedAtMs: null,
  ...over,
});

function decide(over: {
  candidate?: Partial<BlobCandidate>;
  sizeClass?: string | null;
  rows?: Record<string, SizeClassRetention>;
  deniedHere?: boolean;
  pinned?: boolean;
  used?: number;
} = {}) {
  return decideResidency({
    candidate: candidate(over.candidate),
    sizeClass: over.sizeClass === undefined ? "classA" : over.sizeClass,
    policy: policy(over.rows ?? { classA: row() }),
    constraints: { deniedHere: over.deniedHere ?? false },
    overrides: { pinned: over.pinned ?? false },
    usage: () => over.used ?? 0,
    nowMs: NOW,
  });
}

describe("decideResidency — resolution order", () => {
  // The order exists because two inputs pull in opposite directions. Getting it
  // wrong doesn't look like a bug, it looks like a preference being honoured.
  it("lets a record constraint beat a pin", () => {
    const v = decide({ deniedHere: true, pinned: true });
    expect(v.decision).toBe("elide");
    expect(v.reason).toBe("record-constraint");
  });

  it("lets a pin beat an exhausted budget", () => {
    const v = decide({ pinned: true, used: 999_999_999 });
    expect(v.decision).toBe("fetch");
    expect(v.reason).toBe("pinned");
  });

  it("lets a pin beat keep:never", () => {
    const v = decide({ pinned: true, rows: { classA: row({ keep: "never" }) } });
    expect(v.decision).toBe("fetch");
  });
});

describe("decideResidency — keep rules", () => {
  it("fetches under keep:all", () => {
    expect(decide().decision).toBe("fetch");
  });

  it("elides under keep:never", () => {
    const v = decide({ rows: { classA: row({ keep: "never" }) } });
    expect(v).toMatchObject({ decision: "elide", reason: "keep-never" });
  });

  // Not a permanent refusal: an explicit fetch still gets the bytes. It just
  // never happens as part of a sync round.
  it("elides under keep:on-demand-only", () => {
    const v = decide({ rows: { classA: row({ keep: "on-demand-only" }) } });
    expect(v).toMatchObject({ decision: "elide", reason: "on-demand-only" });
  });
});

describe("decideResidency — recency window", () => {
  const recent = { classA: row({ keep: "recent-only" as const, recencyWindowDays: 90 }) };

  it("fetches inside the window", () => {
    const v = decide({ rows: recent, candidate: { recencyAtMs: NOW - 10 * DAY } });
    expect(v).toMatchObject({ decision: "fetch", reason: "within-recency-window" });
  });

  it("elides outside the window", () => {
    const v = decide({ rows: recent, candidate: { recencyAtMs: NOW - 200 * DAY } });
    expect(v).toMatchObject({ decision: "elide", reason: "outside-recency-window" });
  });

  // A library you actually browse has a working set that is not the same shape
  // as its calendar.
  it("keeps something old that was opened recently", () => {
    const rows = {
      classA: row({ keep: "recent-only" as const, recencyWindowDays: 90, openedWithinDays: 30 }),
    };
    const v = decide({
      rows,
      candidate: { recencyAtMs: NOW - 2000 * DAY, lastOpenedAtMs: NOW - 3 * DAY },
    });
    expect(v.decision).toBe("fetch");
  });

  // A metadata gap must not silently cost you the bytes: an unknown date is
  // not evidence of age.
  it("fetches when the record's date is unknown", () => {
    const v = decide({ rows: recent, candidate: { recencyAtMs: null } });
    expect(v.decision).toBe("fetch");
  });
});

describe("decideResidency — budget", () => {
  it("elides when the incoming bytes would exceed the class budget", () => {
    const v = decide({ rows: { classA: row({ budgetBytes: 1500 }) }, used: 1000 });
    // 1000 held + 1000 incoming > 1500.
    expect(v).toMatchObject({ decision: "elide", reason: "budget-exhausted" });
  });

  it("fetches when it fits exactly", () => {
    const v = decide({ rows: { classA: row({ budgetBytes: 2000 }) }, used: 1000 });
    expect(v.decision).toBe("fetch");
  });

  // Budget is checked last so a class the node wants is only ever declined for
  // want of room, never for want of interest — which is what the inspector has
  // to be able to tell the user apart.
  it("reports keep-never rather than budget-exhausted when both apply", () => {
    const v = decide({ rows: { classA: row({ keep: "never" }) }, used: 999_999_999 });
    expect(v.reason).toBe("keep-never");
  });
});

describe("decideResidency — unclassified records", () => {
  // A node that cannot classify something must not silently decline it: the
  // failure mode of over-fetching is a full disk, and the failure mode of
  // under-fetching is data that quietly isn't anywhere.
  it("falls back to the fallback row and fetches by default", () => {
    const v = decideResidency({
      candidate: candidate(),
      sizeClass: null,
      policy: { rows: {}, fallback: row() },
      constraints: { deniedHere: false },
      overrides: { pinned: false },
      usage: () => 0,
      nowMs: NOW,
    });
    expect(v).toMatchObject({ decision: "fetch", reason: "unclassified", sizeClass: null });
  });

  it("uses the fallback for a class the policy has no row for", () => {
    const v = decide({ sizeClass: "unknown-class", rows: { classA: row() } });
    expect(v).toMatchObject({ decision: "fetch", reason: "unclassified" });
  });
});

describe("validateRetentionPolicy", () => {
  // A zero budget reads as a limit and behaves as a prohibition, and it
  // silently disables the recency rule above it — so re-opening yesterday's
  // photo re-downloads it every time. `keep: "never"` says the same thing out
  // loud, so a zero budget is refused at configuration time.
  it("rejects a zero budget on a class the node claims to keep", () => {
    const problems = validateRetentionPolicy(policy({ classA: row({ budgetBytes: 0 }) }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/use keep:"never"/);
  });

  it("allows a zero budget on keep:never, where it means nothing", () => {
    expect(
      validateRetentionPolicy(policy({ classA: row({ keep: "never", budgetBytes: 0 }) })),
    ).toEqual([]);
  });

  it("rejects recent-only with no window at all", () => {
    const problems = validateRetentionPolicy(policy({ classA: row({ keep: "recent-only" }) }));
    expect(problems[0]).toMatch(/needs recencyWindowDays/);
  });

  it("validates the fallback row too", () => {
    const problems = validateRetentionPolicy({
      rows: {},
      fallback: row({ budgetBytes: 0 }),
    });
    expect(problems[0]).toMatch(/^\(fallback\)/);
  });
});
