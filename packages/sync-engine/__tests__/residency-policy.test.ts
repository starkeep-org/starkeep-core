import { describe, it, expect } from "vitest";
import {
  decideResidency,
  resolveSizeClass,
  validateRetentionPolicy,
  PLATFORM_NAMESPACE,
  type AppRetention,
  type BlobCandidate,
  type NodeRetentionPolicy,
  type ResolvedSizeClass,
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

const app = (over: Partial<AppRetention> = {}): AppRetention => ({
  rows: {},
  fallback: row(),
  totalBudgetBytes: 1_000_000_000,
  ...over,
});

/** Rows under one app namespace — the ordinary case for a derived record. */
const policy = (
  rows: Record<string, SizeClassRetention>,
  over: Partial<AppRetention> = {},
): NodeRetentionPolicy => ({
  platform: { rows: {}, fallback: row() },
  apps: { appA: app({ rows, ...over }) },
  appFallback: app(),
});

const CLASS_A = resolveSizeClass("appA", "classA");

const candidate = (over: Partial<BlobCandidate> = {}): BlobCandidate => ({
  recordId: "r1",
  objectStorageKey: "shared/image/aa/" + "a".repeat(64),
  sizeBytes: 1000,
  type: "image/jpeg",
  parentId: null,
  appId: null,
  originAppId: "appA",
  recencyAtMs: NOW,
  lastOpenedAtMs: null,
  ...over,
});

function decide(over: {
  candidate?: Partial<BlobCandidate>;
  sizeClass?: ResolvedSizeClass | null;
  rows?: Record<string, SizeClassRetention>;
  appOver?: Partial<AppRetention>;
  deniedHere?: boolean;
  pinned?: boolean;
  used?: number;
  namespaceUsed?: number;
} = {}) {
  return decideResidency({
    candidate: candidate(over.candidate),
    sizeClass: over.sizeClass === undefined ? CLASS_A : over.sizeClass,
    policy: policy(over.rows ?? { classA: row() }, over.appOver),
    constraints: { deniedHere: over.deniedHere ?? false },
    overrides: { pinned: over.pinned ?? false },
    usage: () => over.used ?? 0,
    namespaceUsage: () => over.namespaceUsed ?? 0,
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

describe("decideResidency — the namespace total", () => {
  // The case the total exists for: every row is comfortable and the app as a
  // whole is not. A per-class check alone finds nothing wrong here.
  it("elides when the app's total is spent even though the class row has room", () => {
    const v = decide({
      rows: { classA: row({ budgetBytes: 1_000_000 }) },
      appOver: { totalBudgetBytes: 5000 },
      used: 0,
      namespaceUsed: 4500,
    });
    expect(v).toMatchObject({ decision: "elide", reason: "namespace-budget-exhausted" });
  });

  it("fetches when the bytes fit both the row and the total", () => {
    const v = decide({
      appOver: { totalBudgetBytes: 5000 },
      used: 0,
      namespaceUsed: 3000,
    });
    expect(v.decision).toBe("fetch");
  });

  // Reported distinctly from `budget-exhausted` because the fix is a different
  // number: raising the class row does nothing until the total moves.
  it("reports the class budget first when both are exhausted", () => {
    const v = decide({
      rows: { classA: row({ budgetBytes: 1200 }) },
      appOver: { totalBudgetBytes: 1200 },
      used: 1000,
      namespaceUsed: 1000,
    });
    expect(v.reason).toBe("budget-exhausted");
  });

  // An invented rung escapes into the app's fallback row, which is per-rung —
  // so without the total, naming a thousand rungs would buy a thousand budgets.
  it("still bounds a rung the policy has never heard of", () => {
    const v = decide({
      sizeClass: resolveSizeClass("appA", "invented-rung"),
      appOver: { totalBudgetBytes: 5000 },
      namespaceUsed: 4999,
    });
    expect(v).toMatchObject({ decision: "elide", reason: "namespace-budget-exhausted" });
  });

  // The platform namespace has rows and no total: a cap above them would be a
  // second way to say the same thing, and the two could disagree.
  it("applies no total to the platform namespace", () => {
    const v = decideResidency({
      candidate: candidate({ parentId: null }),
      sizeClass: resolveSizeClass(PLATFORM_NAMESPACE, "original:image"),
      policy: {
        platform: { rows: { "original:image": row() }, fallback: row() },
        apps: {},
        appFallback: app({ totalBudgetBytes: 1 }),
      },
      constraints: { deniedHere: false },
      overrides: { pinned: false },
      usage: () => 0,
      namespaceUsage: () => 999_999_999,
      nowMs: NOW,
    });
    expect(v.decision).toBe("fetch");
  });

  // An app nobody has budgeted for is not unbounded — that would be the hole
  // every other bound here is trying to close.
  it("bounds an app the policy has no entry for, using appFallback", () => {
    const v = decideResidency({
      candidate: candidate(),
      sizeClass: resolveSizeClass("never-configured", "someRung"),
      policy: {
        platform: { rows: {}, fallback: row() },
        apps: {},
        appFallback: app({ totalBudgetBytes: 2000 }),
      },
      constraints: { deniedHere: false },
      overrides: { pinned: false },
      usage: () => 0,
      namespaceUsage: () => 1500,
      nowMs: NOW,
    });
    expect(v).toMatchObject({ decision: "elide", reason: "namespace-budget-exhausted" });
  });
});

describe("decideResidency — unclassified records", () => {
  // A node that cannot classify something must not silently decline it: the
  // failure mode of over-fetching is a full disk, and the failure mode of
  // under-fetching is data that quietly isn't anywhere.
  it("falls back to the platform fallback row and fetches by default", () => {
    const v = decideResidency({
      candidate: candidate(),
      sizeClass: null,
      policy: { platform: { rows: {}, fallback: row() }, apps: {}, appFallback: app() },
      constraints: { deniedHere: false },
      overrides: { pinned: false },
      usage: () => 0,
      namespaceUsage: () => 0,
      nowMs: NOW,
    });
    expect(v).toMatchObject({ decision: "fetch", reason: "unclassified", sizeClass: null });
  });

  it("uses the app's fallback for a rung the policy has no row for", () => {
    const v = decide({
      sizeClass: resolveSizeClass("appA", "unknown-rung"),
      rows: { classA: row() },
    });
    expect(v).toMatchObject({ decision: "fetch", reason: "unclassified" });
  });

  // An unconfigured app must not inherit the rule written for originals: the
  // platform fallback is generous on purpose, and applying it to an app nobody
  // has budgeted for would hand that generosity to anything newly installed.
  it("uses appFallback rather than the platform fallback for an unknown app", () => {
    const v = decideResidency({
      candidate: candidate(),
      sizeClass: resolveSizeClass("never-configured", "someRung"),
      policy: {
        platform: { rows: {}, fallback: row({ keep: "all" }) },
        apps: {},
        appFallback: app({ fallback: row({ keep: "never" }) }),
      },
      constraints: { deniedHere: false },
      overrides: { pinned: false },
      usage: () => 0,
      namespaceUsage: () => 0,
      nowMs: NOW,
    });
    expect(v).toMatchObject({ decision: "elide", reason: "keep-never" });
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
      platform: { rows: {}, fallback: row({ budgetBytes: 0 }) },
      apps: {},
      appFallback: app(),
    });
    expect(problems[0]).toMatch(/^starkeep \(fallback\)/);
  });

  // A zero total is worse than a zero row: it overrides every row in the
  // namespace, including ones that say "keep everything".
  it("rejects a zero total on an app", () => {
    const problems = validateRetentionPolicy(policy({ classA: row() }, { totalBudgetBytes: 0 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/totalBudgetBytes must be > 0/);
  });

  // A budget is JSON, so it can arrive missing, and `<= 0` does not catch that:
  // `undefined <= 0` and `NaN <= 0` are both false. The value that gets through
  // is worse than a zero, because every later comparison against it is false
  // too — the eviction pass triggers and then never reaches its target.
  it.each([
    ["missing", undefined],
    ["not a number", "8589934592"],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a total that is %s", (_label, totalBudgetBytes) => {
    const problems = validateRetentionPolicy(
      policy({ classA: row() }, { totalBudgetBytes } as Partial<AppRetention>),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/totalBudgetBytes must be > 0/);
  });

  it.each([
    ["missing", undefined],
    ["NaN", Number.NaN],
  ])("rejects a row budget that is %s", (_label, budgetBytes) => {
    const problems = validateRetentionPolicy(
      policy({ classA: row({ budgetBytes } as Partial<SizeClassRetention>) }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/budgetBytes must be > 0/);
  });

  it("rejects a zero total on appFallback", () => {
    const problems = validateRetentionPolicy({
      platform: { rows: {}, fallback: row() },
      apps: {},
      appFallback: app({ totalBudgetBytes: 0 }),
    });
    expect(problems[0]).toMatch(/^\(unconfigured apps\)/);
  });

  // Rows written under the platform's own name would never be read: class
  // resolution sends every platform class to `platform.rows`, so this whole
  // entry would sit there being ignored rather than doing what it says.
  it("rejects an app namespace that collides with the platform's", () => {
    const problems = validateRetentionPolicy({
      platform: { rows: {}, fallback: row() },
      apps: { [PLATFORM_NAMESPACE]: app({ rows: { classA: row() } }) },
      appFallback: app(),
    });
    expect(problems.some((p) => /is the platform namespace/.test(p))).toBe(true);
  });

  // A policy is JSON from a config file or a PUT body, so the type is a claim,
  // not a guarantee. This function's whole job is turning a bad policy into
  // sentences — throwing instead means a node refuses to boot with a stack
  // trace rather than saying which part of its policy is missing.
  it("reports a missing section rather than throwing", () => {
    const problems = validateRetentionPolicy({
      platform: { rows: {}, fallback: row() },
      apps: {},
    } as unknown as NodeRetentionPolicy);
    expect(problems).toEqual(["appFallback: missing or not an object"]);
  });

  it("reports a malformed app entry rather than throwing", () => {
    const problems = validateRetentionPolicy({
      platform: { rows: {}, fallback: row() },
      apps: { photos: "not a policy" },
      appFallback: app(),
    } as unknown as NodeRetentionPolicy);
    expect(problems[0]).toMatch(/^photos: missing or malformed rows/);
  });

  // The structural guard covers the sections but not the `fallback` inside
  // them, so these used to read `.keep` off `undefined` and answer a PUT with a
  // 500 and a stack trace instead of a 422 and a sentence.
  it.each([
    [
      "platform.fallback",
      { platform: { rows: {} }, apps: {}, appFallback: app() },
      /^starkeep \(fallback\): missing or not an object/,
    ],
    [
      "an app's fallback",
      {
        platform: { rows: {}, fallback: row() },
        apps: { photos: { rows: {}, totalBudgetBytes: 1024 } },
        appFallback: app(),
      },
      /^photos \(fallback\): missing or not an object/,
    ],
    [
      "appFallback's fallback",
      {
        platform: { rows: {}, fallback: row() },
        apps: {},
        appFallback: { rows: {}, totalBudgetBytes: 1024 },
      },
      /^\(unconfigured apps\) \(fallback\): missing or not an object/,
    ],
    [
      "a null row",
      { platform: { rows: { "original:image": null }, fallback: row() }, apps: {}, appFallback: app() },
      /^starkeep:original:image: missing or not an object/,
    ],
  ])("reports a missing %s rather than throwing", (_label, malformed, expected) => {
    const problems = validateRetentionPolicy(malformed as unknown as NodeRetentionPolicy);
    expect(problems[0]).toMatch(expected);
  });

  it("names the offending row with its full class", () => {
    const problems = validateRetentionPolicy(policy({ classA: row({ budgetBytes: 0 }) }));
    expect(problems[0]).toMatch(/^appA:classA/);
  });
});
