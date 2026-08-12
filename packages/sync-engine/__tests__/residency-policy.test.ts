import { describe, it, expect } from "vitest";
import {
  budgetBytesFor,
  budgetLineFor,
  budgetLinesOf,
  compareEvictionRank,
  decideResidency,
  resolveSizeClass,
  retentionRowFor,
  validateRetentionPolicy,
  FALLBACK_RUNG,
  PLATFORM_NAMESPACE,
  type BlobCandidate,
  type EvictionRank,
  type NamespaceRetention,
  type NodeRetentionPolicy,
  type ResidencyTrigger,
  type ResolvedSizeClass,
  type SizeClassRetention,
} from "../src/residency-policy.js";

const NOW = Date.UTC(2026, 7, 1);
const DAY = 24 * 60 * 60 * 1000;

// Class names here are deliberately nonsense. The platform must never learn
// what `image-medium` is, and a test that used real ladder names would quietly
// encode the opposite assumption.
const row = (over: Partial<SizeClassRetention> = {}): SizeClassRetention => ({
  prefetch: true,
  share: 1,
  ...over,
});

const app = (over: Partial<NamespaceRetention> = {}): NamespaceRetention => ({
  rows: {},
  fallback: row(),
  budgetBytes: 1_000_000,
  ...over,
});

/** Rows under one app namespace — the ordinary case for a derived record. */
const policy = (
  rows: Record<string, SizeClassRetention>,
  over: Partial<NamespaceRetention> = {},
): NodeRetentionPolicy => ({
  platform: app(),
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

function decide(
  over: {
    candidate?: Partial<BlobCandidate>;
    sizeClass?: ResolvedSizeClass | null;
    rows?: Record<string, SizeClassRetention>;
    appOver?: Partial<NamespaceRetention>;
    deniedHere?: boolean;
    pinned?: boolean;
    used?: number;
    /** Whether the host says enough worse-ranked bytes exist to displace. */
    displaces?: boolean;
    trigger?: ResidencyTrigger;
  } = {},
) {
  return decideResidency({
    candidate: candidate(over.candidate),
    sizeClass: over.sizeClass === undefined ? CLASS_A : over.sizeClass,
    policy: policy(over.rows ?? { classA: row() }, over.appOver),
    constraints: { deniedHere: over.deniedHere ?? false },
    overrides: { pinned: over.pinned ?? false },
    usage: () => over.used ?? 0,
    displaces: () => over.displaces ?? false,
    ...(over.trigger === undefined ? {} : { trigger: over.trigger }),
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

  it("lets a pin beat a zero share", () => {
    const v = decide({ pinned: true, rows: { classA: row({ share: 0 }) } });
    expect(v.decision).toBe("fetch");
  });
});

describe("decideResidency — the two fields a row has left", () => {
  it("fetches a prefetched class with room", () => {
    expect(decide().decision).toBe("fetch");
  });

  // Zero is the whole of what `keep: "never"` used to say, and it says it in
  // the one field that decides how many bytes a line may hold — so there is no
  // longer a rule and a budget that can contradict each other.
  it("elides a class whose share is zero", () => {
    const v = decide({ rows: { classA: row({ share: 0 }) } });
    expect(v).toMatchObject({ decision: "elide", reason: "class-disabled" });
  });

  // Not a permanent refusal: an explicit fetch still gets the bytes. It just
  // never happens as part of a sync round.
  it("elides an unprefetched class during a sync round", () => {
    const v = decide({ rows: { classA: row({ prefetch: false }) } });
    expect(v).toMatchObject({ decision: "elide", reason: "not-prefetched" });
  });

  // A request is not speculation, so the field about speculation does not apply
  // to it — and everything else still does, which is what makes read-through and
  // admission one rule rather than two that can disagree.
  it("fetches an unprefetched class when something actually asked for it", () => {
    const v = decide({ rows: { classA: row({ prefetch: false }) }, trigger: "request" });
    expect(v).toMatchObject({ decision: "fetch", reason: "within-budget" });
  });

  // A request does not buy an exemption from the budget. Landing bytes the next
  // eviction pass would immediately delete is a download and a delete, and the
  // read is served remotely either way.
  it("still declines a request that would be the first thing evicted", () => {
    const v = decide({
      rows: { classA: row({ prefetch: false }) },
      trigger: "request",
      used: 999_999_999,
      displaces: false,
    });
    expect(v).toMatchObject({ decision: "elide", reason: "budget-exhausted" });
  });

  // A zero share is not "ask and you shall receive": it is this node holding
  // none of the class, so a request cannot conjure a budget for it.
  it("refuses a request for a class whose share is zero", () => {
    const v = decide({ rows: { classA: row({ share: 0 }) }, trigger: "request" });
    expect(v).toMatchObject({ decision: "elide", reason: "class-disabled" });
  });
});

describe("decideResidency — budget and displacement", () => {
  it("fetches when it fits", () => {
    const v = decide({ used: 1000 });
    expect(v).toMatchObject({ decision: "fetch", reason: "within-budget" });
  });

  // The acquisition-order problem, which is what the old recency window was
  // quietly standing in for. A sync round walks the change log oldest-first, so
  // a budget that simply stopped at full would fill a device with its oldest
  // material and decline everything since.
  it("fetches past a full line when the blob outranks enough of what is held", () => {
    const v = decide({ used: 999_999_999, displaces: true, trigger: "acquisition" });
    expect(v).toMatchObject({ decision: "fetch", reason: "displaces-worse" });
  });

  /**
   * The rule that bounds a cold sync, and the one place the three triggers
   * genuinely disagree about the same blob.
   *
   * A round walks the change log oldest-first, so on a device whose budget
   * binds *every* arrival outranks everything held — and admitting each of them
   * pulls the whole library across the network to keep the last budget's worth
   * of it. The round therefore declines and queues; the acquisition pass, whose
   * queue is best-first, is where a displacement is a swap rather than a
   * stampede.
   */
  it("refuses to displace for a round, and does not even ask the host", () => {
    let asked = false;
    const v = decideResidency({
      candidate: candidate(),
      sizeClass: CLASS_A,
      policy: policy({ classA: row() }),
      constraints: { deniedHere: false },
      overrides: { pinned: false },
      usage: () => 999_999_999,
      displaces: () => {
        asked = true;
        return true;
      },
      trigger: "round",
    });
    expect(v).toMatchObject({ decision: "elide", reason: "budget-exhausted" });
    expect(asked).toBe(false);
  });

  it("displaces for a direct request", () => {
    const v = decide({ used: 999_999_999, displaces: true, trigger: "request" });
    expect(v).toMatchObject({ decision: "fetch", reason: "displaces-worse" });
  });

  it("elides a full line when nothing held ranks worse", () => {
    const v = decide({ used: 999_999_999, displaces: false, trigger: "acquisition" });
    expect(v).toMatchObject({ decision: "elide", reason: "budget-exhausted" });
  });

  // Only the overflow has to be displaceable, not the whole blob — otherwise a
  // line one byte over its budget would refuse everything.
  it("asks only for the bytes that overflow", () => {
    let asked = -1;
    decideResidency({
      candidate: candidate({ sizeBytes: 1000 }),
      sizeClass: CLASS_A,
      // One line at share 1 against the fallback's share 1 — half of 1,000,000.
      policy: policy({ classA: row() }),
      constraints: { deniedHere: false },
      overrides: { pinned: false },
      usage: () => 499_800,
      displaces: (_line, _rank, bytesNeeded) => {
        asked = bytesNeeded;
        return true;
      },
      trigger: "request",
    });
    // 499,800 held + 1,000 incoming - 500,000 budget.
    expect(asked).toBe(800);
  });

  // The candidate's own place in the order is what the host compares against,
  // so it has to arrive intact rather than being re-derived from the record.
  it("passes the candidate's rank to the host", () => {
    let seen: EvictionRank | null = null;
    decideResidency({
      candidate: candidate({ lastOpenedAtMs: NOW - DAY, recencyAtMs: NOW - 500 * DAY }),
      sizeClass: CLASS_A,
      policy: policy({ classA: row() }),
      constraints: { deniedHere: false },
      overrides: { pinned: false },
      usage: () => 999_999_999,
      trigger: "acquisition",
      displaces: (_line, rank) => {
        seen = rank;
        return false;
      },
    });
    expect(seen).toEqual({ lastOpenedAtMs: NOW - DAY, recencyAtMs: NOW - 500 * DAY });
  });

  // Budget is checked last so a class the node wants is only ever declined for
  // want of room, never for want of interest — which is what the inspector has
  // to be able to tell the user apart.
  it("reports class-disabled rather than budget-exhausted when both apply", () => {
    const v = decide({ rows: { classA: row({ share: 0 }) }, used: 999_999_999 });
    expect(v.reason).toBe("class-disabled");
  });
});

describe("budget lines", () => {
  // The identity the whole change rests on: a node inside every line of a
  // namespace is inside that namespace, so there is nothing left for a
  // second, namespace-wide pass to catch.
  it("divides a namespace's budget exactly across its lines", () => {
    const p: NodeRetentionPolicy = {
      platform: app(),
      apps: {
        appA: app({
          rows: { a: row({ share: 1 }), b: row({ share: 2 }), c: row({ share: 4 }) },
          fallback: row({ share: 1 }),
          budgetBytes: 8000,
        }),
      },
      appFallback: app(),
    };
    const lines = budgetLinesOf(p).filter((l) => l.namespace === "appA");
    const sum = lines.reduce((total, l) => total + budgetBytesFor(p, l), 0);
    expect(sum).toBe(8000);
  });

  it("gives a share its proportion of the namespace budget", () => {
    const p = policy({ classA: row({ share: 3 }) }, { budgetBytes: 4000 });
    // share 3 of (3 + fallback 1).
    expect(budgetBytesFor(p, budgetLineFor(p, CLASS_A))).toBe(3000);
  });

  it("gives a zero share zero bytes", () => {
    const p = policy({ classA: row({ share: 0 }) });
    expect(budgetBytesFor(p, budgetLineFor(p, CLASS_A))).toBe(0);
  });

  // The rung-invention hole, closed structurally rather than by a second cap.
  // Under absolute per-row budgets an app naming a thousand rungs got a
  // thousand fallback budgets, which is exactly why a namespace-wide total had
  // to exist to bound it.
  it("pools every unrecognised rung of a namespace onto one line", () => {
    const p = policy({ classA: row() });
    const one = budgetLineFor(p, resolveSizeClass("appA", "invented-1"));
    const two = budgetLineFor(p, resolveSizeClass("appA", "invented-2"));
    expect(one.key).toBe(two.key);
    expect(one.rung).toBe(FALLBACK_RUNG);
  });

  it("keeps a declared rung on its own line", () => {
    const p = policy({ classA: row() });
    expect(budgetLineFor(p, CLASS_A).key).toBe("appA:classA");
  });

  // An unresolvable class has no namespace to belong to, and guessing one would
  // charge somebody's budget for it.
  it("sends an unresolvable class to the platform's pooled line", () => {
    const p = policy({ classA: row() });
    expect(budgetLineFor(p, null).key).toBe(`${PLATFORM_NAMESPACE}:${FALLBACK_RUNG}`);
  });

  // An app nobody has budgeted for is not unbounded — that would be the hole
  // every other bound here is trying to close.
  it("bounds an app the policy has no entry for, using appFallback", () => {
    const p: NodeRetentionPolicy = {
      platform: app(),
      apps: {},
      appFallback: app({ budgetBytes: 2000 }),
    };
    const line = budgetLineFor(p, resolveSizeClass("never-configured", "someRung"));
    expect(budgetBytesFor(p, line)).toBe(2000);
  });

  it("enumerates every declared line plus each namespace's fallback", () => {
    const keys = budgetLinesOf(policy({ classA: row(), classB: row() })).map((l) => l.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        `${PLATFORM_NAMESPACE}:${FALLBACK_RUNG}`,
        "appA:classA",
        "appA:classB",
        `appA:${FALLBACK_RUNG}`,
      ]),
    );
  });
});

describe("decideResidency — unclassified records", () => {
  // A node that cannot classify something must not silently decline it: the
  // failure mode of over-fetching is a full disk, and the failure mode of
  // under-fetching is data that quietly isn't anywhere.
  it("falls back to the platform's pooled line and fetches by default", () => {
    const v = decide({ sizeClass: null });
    expect(v).toMatchObject({ decision: "fetch", reason: "unclassified", sizeClass: null });
    expect(v.budgetLine?.key).toBe(`${PLATFORM_NAMESPACE}:${FALLBACK_RUNG}`);
  });

  it("uses the app's fallback for a rung the policy has no row for", () => {
    const v = decide({ sizeClass: resolveSizeClass("appA", "unknown-rung") });
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
        platform: app({ fallback: row({ share: 1 }) }),
        apps: {},
        appFallback: app({ fallback: row({ share: 0 }) }),
      },
      constraints: { deniedHere: false },
      overrides: { pinned: false },
      usage: () => 0,
      displaces: () => false,
    });
    expect(v).toMatchObject({ decision: "elide", reason: "class-disabled" });
  });
});

describe("compareEvictionRank", () => {
  const rank = (lastOpenedAtMs: number | null, recencyAtMs: number | null): EvictionRank => ({
    lastOpenedAtMs,
    recencyAtMs,
  });

  // Why use beats age: ordering by date alone thrashes on the behaviour people
  // actually have. Browse a 2005 album and each photograph lands, is displaced
  // by the next, and is fetched again next time — egress paid twice per photo.
  it("gives up never-opened material before anything anyone has looked at", () => {
    expect(compareEvictionRank(rank(null, NOW), rank(NOW - 5000 * DAY, null))).toBeLessThan(0);
  });

  it("gives up the least recently opened first", () => {
    expect(compareEvictionRank(rank(NOW - 10 * DAY, NOW), rank(NOW - DAY, NOW))).toBeLessThan(0);
  });

  it("falls back to the record's own date when opens tie", () => {
    expect(
      compareEvictionRank(rank(NOW - DAY, NOW - 100 * DAY), rank(NOW - DAY, NOW)),
    ).toBeLessThan(0);
  });

  it("ties two blobs with the same rank", () => {
    expect(compareEvictionRank(rank(NOW, NOW), rank(NOW, NOW))).toBe(0);
  });

  // Mirrors SQLite putting NULL first in an ascending sort, which is what the
  // resident set's `ORDER BY` does. The two are one ordering written twice and
  // they must not disagree — the admission check asks this about a blob that
  // has no row yet, and the pass asks SQLite about the rows it has.
  it("ranks an undated blob below a dated one, matching the SQL", () => {
    expect(compareEvictionRank(rank(NOW, null), rank(NOW, 0))).toBeLessThan(0);
  });
});

describe("retentionRowFor", () => {
  it("reads a declared row", () => {
    const p = policy({ classA: row({ prefetch: false, share: 7 }) });
    expect(retentionRowFor(p, budgetLineFor(p, CLASS_A))).toMatchObject({
      prefetch: false,
      share: 7,
    });
  });

  it("reads the fallback for a pooled line", () => {
    const p = policy({ classA: row() }, { fallback: row({ prefetch: false, share: 2 }) });
    const line = budgetLineFor(p, resolveSizeClass("appA", "invented"));
    expect(retentionRowFor(p, line)).toMatchObject({ prefetch: false, share: 2 });
  });
});

describe("validateRetentionPolicy", () => {
  it("accepts an ordinary policy", () => {
    expect(validateRetentionPolicy(policy({ classA: row() }))).toEqual([]);
  });

  // Zero is a real answer for a *row* — it is how a node says it holds none of
  // a class. It is not a real answer for the namespace, where it is a
  // prohibition on every rung written in the one place an operator reading the
  // rows will not look.
  it("accepts a zero share on a row", () => {
    expect(validateRetentionPolicy(policy({ classA: row({ share: 0 }) }))).toEqual([]);
  });

  it("rejects a zero namespace budget", () => {
    const problems = validateRetentionPolicy(policy({ classA: row() }, { budgetBytes: 0 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/budgetBytes must be > 0/);
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
  ])("rejects a namespace budget that is %s", (_label, budgetBytes) => {
    const problems = validateRetentionPolicy(
      policy({ classA: row() }, { budgetBytes } as Partial<NamespaceRetention>),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/budgetBytes must be > 0/);
  });

  // A namespace whose shares are all zero divides a real budget into nothing.
  // Almost always a table somebody half-filled in, and silent otherwise.
  it("rejects a namespace where every share is zero", () => {
    const problems = validateRetentionPolicy(
      policy({ classA: row({ share: 0 }) }, { fallback: row({ share: 0 }) }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/every share is zero/);
  });

  // Negative and non-finite shares are refused rather than clamped: a clamped
  // one would silently become `share: 0`, which is a real policy the operator
  // did not write.
  it.each([
    ["missing", undefined],
    ["NaN", Number.NaN],
    ["negative", -1],
    ["a string", "50"],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("rejects a share that is %s", (_label, share) => {
    const problems = validateRetentionPolicy(
      policy({ classA: row({ share } as unknown as Partial<SizeClassRetention>) }),
    );
    expect(problems.some((p) => /share must be a finite number/.test(p))).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "yes"],
    ["a number", 1],
  ])("rejects a prefetch that is %s", (_label, prefetch) => {
    const problems = validateRetentionPolicy(
      policy({ classA: { prefetch, share: 1 } as unknown as SizeClassRetention }),
    );
    expect(problems[0]).toMatch(/prefetch must be true or false/);
  });

  it("validates the fallback row too", () => {
    const problems = validateRetentionPolicy({
      platform: app({ fallback: row({ share: -1 }) }),
      apps: {},
      appFallback: app(),
    });
    expect(problems[0]).toMatch(/^starkeep \(fallback\)/);
  });

  it("names the offending row with its full class", () => {
    const problems = validateRetentionPolicy(policy({ classA: row({ share: -1 }) }));
    expect(problems[0]).toMatch(/^appA:classA/);
  });

  // `*` names the pooled line, so a rung called that would write a row nothing
  // could ever read — its own row and the fallback would share a key.
  it("rejects a rung named with the reserved fallback marker", () => {
    const problems = validateRetentionPolicy(policy({ [FALLBACK_RUNG]: row() }));
    expect(problems.some((p) => /is reserved for the pooled fallback line/.test(p))).toBe(true);
  });

  // Rows written under the platform's own name would never be read: class
  // resolution sends every platform class to `platform.rows`, so this whole
  // entry would sit there being ignored rather than doing what it says.
  it("rejects an app namespace that collides with the platform's", () => {
    const problems = validateRetentionPolicy({
      platform: app(),
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
      platform: app(),
      apps: {},
    } as unknown as NodeRetentionPolicy);
    expect(problems).toEqual(["appFallback: missing or not an object"]);
  });

  it("reports a malformed app entry rather than throwing", () => {
    const problems = validateRetentionPolicy({
      platform: app(),
      apps: { photos: "not a policy" },
      appFallback: app(),
    } as unknown as NodeRetentionPolicy);
    expect(problems[0]).toMatch(/^photos: missing or malformed rows/);
  });

  // The structural guard covers the sections but not the `fallback` inside
  // them, so these used to read a field off `undefined` and answer a PUT with a
  // 500 and a stack trace instead of a 422 and a sentence.
  it.each([
    [
      "platform.fallback",
      { platform: { rows: {}, budgetBytes: 1024 }, apps: {}, appFallback: app() },
      /^starkeep \(fallback\): missing or not an object/,
    ],
    [
      "an app's fallback",
      {
        platform: app(),
        apps: { photos: { rows: {}, budgetBytes: 1024 } },
        appFallback: app(),
      },
      /^photos \(fallback\): missing or not an object/,
    ],
    [
      "appFallback's fallback",
      { platform: app(), apps: {}, appFallback: { rows: {}, budgetBytes: 1024 } },
      /^\(unconfigured apps\) \(fallback\): missing or not an object/,
    ],
    [
      "a null row",
      {
        platform: { rows: { "original:image": null }, fallback: row(), budgetBytes: 1024 },
        apps: {},
        appFallback: app(),
      },
      /^starkeep:original:image: missing or not an object/,
    ],
  ])("reports a missing %s rather than throwing", (_label, malformed, expected) => {
    const problems = validateRetentionPolicy(malformed as unknown as NodeRetentionPolicy);
    expect(problems[0]).toMatch(expected);
  });
});
