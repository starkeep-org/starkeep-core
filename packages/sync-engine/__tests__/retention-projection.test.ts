/**
 * Projecting a retention policy's disk cost (item 34).
 *
 * The matrix is edited *before* it takes effect, so the projection's job is to
 * answer "what happens if I do this" while the operator is deciding.
 *
 * This suite lost most of its cases along with the thing they covered: the
 * projection used to estimate what a date rule would select, from seven
 * cumulative cutoffs, rounding up at every step because it could not know how
 * two windows overlapped. There is no date rule now, so there is nothing to
 * estimate — a class either gets pulled or it does not, and the share decides
 * the rest.
 */
import { describe, it, expect } from "vitest";
import { projectPolicy, formatBytes, type SizeClassCensus } from "../src/retention-projection.js";
import {
  validateRetentionPolicy,
  type NamespaceRetention,
  type NodeRetentionPolicy,
  type SizeClassRetention,
} from "../src/residency-policy.js";

const GB = 1024 ** 3;

const census = (over: Partial<SizeClassCensus> = {}): SizeClassCensus => ({
  sizeClass: "photos:image-large",
  recordCount: 1000,
  totalBytes: 100 * GB,
  ...over,
});

const row = (over: Partial<SizeClassRetention> = {}): SizeClassRetention => ({
  prefetch: true,
  share: 1,
  ...over,
});

/**
 * A policy with one app namespace.
 *
 * The fallback takes no share unless a case says otherwise, so the declared
 * rows divide the whole budget between them and the arithmetic in each test is
 * about the thing the test is checking.
 */
const withApp = (
  rows: Record<string, SizeClassRetention>,
  budgetBytes = 100 * GB,
  fallback: SizeClassRetention = row({ share: 0 }),
): NodeRetentionPolicy => {
  const namespace: NamespaceRetention = { rows, fallback, budgetBytes };
  return {
    platform: { rows: {}, fallback: row(), budgetBytes: 900 * GB },
    apps: { photos: namespace },
    appFallback: { rows: {}, fallback: row(), budgetBytes: 8 * GB },
  };
};

describe("a row's budget is its share of the namespace", () => {
  const policy = withApp({
    "image-thumb": row({ share: 1 }),
    "image-large": row({ share: 9 }),
  });
  const library = [
    census({ sizeClass: "photos:image-thumb", totalBytes: 2 * GB }),
    census({ sizeClass: "photos:image-large", totalBytes: 100 * GB }),
  ];

  it("divides the namespace budget by share", () => {
    const projection = projectPolicy(policy, library);
    const byClass = new Map(projection.rows.map((r) => [r.sizeClass, r]));
    expect(byClass.get("photos:image-thumb")!.budgetBytes).toBe(10 * GB);
    expect(byClass.get("photos:image-large")!.budgetBytes).toBe(90 * GB);
  });

  it("holds what the class contains when it fits", () => {
    const thumb = projectPolicy(policy, library).rows.find(
      (r) => r.sizeClass === "photos:image-thumb",
    )!;
    expect(thumb.projectedBytes).toBe(2 * GB);
    expect(thumb.overBudget).toBe(false);
  });

  // Worth surfacing rather than silently capping: it means the device holds the
  // most useful part of the class rather than all of it, which is a different
  // sentence from "this class fits".
  it("caps at the budget and flags the class", () => {
    const large = projectPolicy(policy, library).rows.find(
      (r) => r.sizeClass === "photos:image-large",
    )!;
    expect(large.selectedBytes).toBe(100 * GB);
    expect(large.projectedBytes).toBe(90 * GB);
    expect(large.overBudget).toBe(true);
    expect(projectPolicy(policy, library).overBudgetClasses).toEqual(["photos:image-large"]);
  });

  it("holds nothing for a class whose share is zero", () => {
    const off = withApp({ "image-thumb": row(), "image-large": row({ share: 0 }) });
    const large = projectPolicy(off, library).rows.find(
      (r) => r.sizeClass === "photos:image-large",
    )!;
    expect(large.budgetBytes).toBe(0);
    expect(large.projectedBytes).toBe(0);
  });

  // Pins win over budgets, so a row can legitimately exceed its own cap. A
  // projection that reported the budget instead would promise a number the
  // engine has already been told it may not deliver.
  it("holds pinned bytes even past the budget", () => {
    const off = withApp({ "image-large": row({ share: 0 }) });
    const projected = projectPolicy(off, [census({ pinnedBytes: 12 * GB })]).rows[0]!;
    expect(projected.projectedBytes).toBe(12 * GB);
    expect(projected.pinnedBytes).toBe(12 * GB);
  });
});

describe("prefetch shows as a floor rather than a settled figure", () => {
  // Projecting an unprefetched class at its contents would be badly wrong in
  // the other direction: nothing is pulled proactively, so the number an
  // operator should read is "grows toward the budget as you browse".
  it("flags an unprefetched class as demand-driven", () => {
    const p = projectPolicy(withApp({ "image-large": row({ prefetch: false }) }), [census()]);
    expect(p.rows[0]!.demandDriven).toBe(true);
  });

  it("does not flag a prefetched class", () => {
    const p = projectPolicy(withApp({ "image-large": row() }), [census()]);
    expect(p.rows[0]!.demandDriven).toBe(false);
  });
});

describe("projecting a whole policy", () => {
  const policy = withApp({
    "image-thumb": row({ share: 1 }),
    "image-large": row({ share: 9 }),
  });
  const library = [
    census({ sizeClass: "photos:image-thumb", totalBytes: 2 * GB }),
    census({ sizeClass: "photos:image-large", totalBytes: 100 * GB }),
  ];

  it("totals the rows", () => {
    expect(projectPolicy(policy, library).totalProjectedBytes).toBe(2 * GB + 90 * GB);
  });

  // A projection that quietly ignored unlisted classes would under-report
  // exactly the disk use nobody planned for.
  it("pools classes the policy does not mention onto the fallback line", () => {
    const withFallback = withApp(
      { "image-thumb": row({ share: 1 }), "image-large": row({ share: 8 }) },
      100 * GB,
      row({ share: 1 }),
    );
    const extra = [
      ...library,
      census({ sizeClass: "photos:video-720p", totalBytes: 80 * GB }),
      census({ sizeClass: "photos:video-1080p", totalBytes: 80 * GB }),
    ];
    const projection = projectPolicy(withFallback, extra);
    const pooled = projection.rows.filter((r) => r.budgetLineKey === "photos:*");

    // Both appear in the table, which is the point: the operator can see the
    // classes exist and how much of them survives.
    expect(pooled.map((r) => r.sizeClass).sort()).toEqual([
      "photos:video-1080p",
      "photos:video-720p",
    ]);
    // And they share the line's 10 GB rather than getting 10 GB each — the
    // over-report that made rung invention free in the first place.
    expect(pooled.reduce((sum, r) => sum + r.projectedBytes, 0)).toBe(10 * GB);
  });

  /**
   * The identity the whole change rests on.
   *
   * Rows used to carry absolute byte counts *and* a namespace total was checked
   * separately, so the two could disagree — in the shipped phone policy they
   * did, by 240 MB. Shares make the row budgets sum to the namespace budget by
   * construction, so a projection can never promise disk the namespace pass
   * would take straight back.
   */
  it("never projects a namespace past its budget except by pins", () => {
    const projection = projectPolicy(policy, library);
    const photos = projection.namespaces.find((n) => n.namespace === "photos")!;
    expect(photos.projectedBytes).toBeLessThanOrEqual(photos.totalBudgetBytes);
    expect(projection.overTotalNamespaces).toEqual([]);
  });

  it("flags a namespace held past its budget by pins", () => {
    const off = withApp({ "image-large": row({ share: 0 }) }, 10 * GB);
    const projection = projectPolicy(off, [census({ pinnedBytes: 40 * GB })]);
    expect(projection.overTotalNamespaces).toEqual(["photos"]);
  });

  // The platform used to be the exception — rows with absolute budgets and no
  // total — which only ever bought a `number | null` every consumer had to
  // branch on, and an operator with no way to say how much disk originals get.
  it("gives the platform namespace a budget like any other", () => {
    const projection = projectPolicy(policy, [
      census({ sizeClass: "starkeep:original:image", totalBytes: 9000 * GB }),
    ]);
    const platform = projection.namespaces.find((n) => n.namespace === "starkeep")!;
    expect(platform.totalBudgetBytes).toBe(900 * GB);
    expect(platform.projectedBytes).toBe(900 * GB);
  });

  // A class name from before namespacing has no namespace to group under, and
  // guessing one would charge somebody's budget for it.
  it("sends an unqualified class to the platform's pooled line", () => {
    const projection = projectPolicy(policy, [
      census({ sizeClass: "image-medium", totalBytes: GB }),
    ]);
    expect(projection.rows[0]!.budgetLineKey).toBe("starkeep:*");
  });
});

/**
 * r4 #11 — the projection never produces `NaN` for a policy the validator
 * accepted.
 *
 * Stated as a property rather than as cases, because the ways it happened were
 * unrelated to each other and none was on anybody's list: a `never` row with no
 * `budgetBytes` reached `Math.min(selected, undefined)`, and an unrecognised
 * `keep` fell off the end of a switch and returned `undefined`. What they share
 * is only the symptom, and the symptom is silent: one `NaN` three levels down
 * propagates through the namespace subtotal into `totalProjectedBytes`, and an
 * operator sees a blank headline figure with no indication which row caused it.
 *
 * Both of those specific shapes are now unrepresentable — there is no keep enum
 * to mistype and no second budget to omit — which is the better kind of fix.
 * The property is kept because it is the one that survives the next change:
 * **anything the validator lets through must project to a number.**
 */
describe("a policy the validator accepted always projects to a number", () => {
  const rules: SizeClassRetention[] = [
    { prefetch: true, share: 1 },
    { prefetch: false, share: 1 },
    { prefetch: true, share: 0.5 },
    { prefetch: true, share: 1000 },
  ];

  const libraries: SizeClassCensus[][] = [
    [],
    [census()],
    [
      census(),
      census({ sizeClass: "photos:video-720p", totalBytes: 80 * GB }),
      census({ sizeClass: "starkeep:original:image", totalBytes: 900 * GB }),
      // A class the census measured at zero — an ordinary state of a young
      // library, and the one that divides by it.
      census({ sizeClass: "photos:image-thumb", totalBytes: 0 }),
      census({ sizeClass: "photos:invented-a", totalBytes: 0 }),
      census({ sizeClass: "photos:invented-b", totalBytes: 0 }),
    ],
  ];

  function isFiniteNumber(value: unknown): boolean {
    return typeof value === "number" && Number.isFinite(value);
  }

  it.each(rules.map((r) => [JSON.stringify(r), r] as const))(
    "projects finite bytes everywhere for %s",
    (_label, rule) => {
      for (const library of libraries) {
        const policy: NodeRetentionPolicy = {
          platform: { rows: { "original:image": rule }, fallback: rule, budgetBytes: 100 * GB },
          apps: {
            photos: { rows: { "image-large": rule }, fallback: rule, budgetBytes: 100 * GB },
          },
          appFallback: { rows: {}, fallback: rule, budgetBytes: 100 * GB },
        };
        // The pairing that makes this a property and not a sample: if the
        // validator would refuse the policy, the projection owes it nothing.
        expect(validateRetentionPolicy(policy)).toEqual([]);

        const projection = projectPolicy(policy, library);
        expect(isFiniteNumber(projection.totalProjectedBytes)).toBe(true);
        for (const row of projection.rows) {
          expect(isFiniteNumber(row.projectedBytes)).toBe(true);
          expect(isFiniteNumber(row.selectedBytes)).toBe(true);
          expect(isFiniteNumber(row.budgetBytes)).toBe(true);
        }
        for (const ns of projection.namespaces) {
          expect(isFiniteNumber(ns.projectedBytes)).toBe(true);
        }
      }
    },
  );

  // A namespace where every share is zero divides its budget into nothing, and
  // the division would be by zero. The validator refuses it, so the projection
  // owes it nothing — but it must still answer with a number rather than a NaN,
  // because a candidate policy is projected *before* it is saved.
  it("answers zero rather than NaN for a namespace with no shares at all", () => {
    const policy: NodeRetentionPolicy = {
      platform: { rows: {}, fallback: row({ share: 0 }), budgetBytes: 100 * GB },
      apps: {},
      appFallback: { rows: {}, fallback: row({ share: 0 }), budgetBytes: 100 * GB },
    };
    expect(validateRetentionPolicy(policy).length).toBeGreaterThan(0);
    const projection = projectPolicy(policy, [census({ sizeClass: "starkeep:original:image" })]);
    expect(projection.totalProjectedBytes).toBe(0);
  });
});

describe("formatting", () => {
  // Binary units, because this is disk space and every OS the operator will
  // check against reports the same way — a UI saying 40 GB beside a Finder
  // saying 37.2 GB reads as a bug in the UI.
  it("uses binary units", () => {
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(GB)).toBe("1 GiB");
    expect(formatBytes(1.5 * GB)).toBe("1.5 GiB");
  });

  it("drops the fraction once the number is large enough not to need it", () => {
    expect(formatBytes(150 * GB)).toBe("150 GiB");
  });

  it("handles zero and nonsense without producing NaN", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});
