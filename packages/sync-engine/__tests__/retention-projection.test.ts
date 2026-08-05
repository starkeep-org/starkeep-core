/**
 * Projecting a retention policy's disk cost (item 34).
 *
 * The matrix is edited *before* it takes effect, so the projection's job is to
 * answer "what happens if I do this" while the operator is deciding. Every
 * rounding decision below leans the same way — **over-estimate** — because an
 * operator told a row costs more than it does buys a bigger disk, while one
 * told it costs less runs out of space and starts evicting things they asked
 * to keep.
 */
import { describe, it, expect } from "vitest";
import {
  projectPolicy,
  projectRow,
  selectedBytesFor,
  formatBytes,
  type SizeClassCensus,
} from "../src/retention-projection.js";
import type { NodeRetentionPolicy, SizeClassRetention } from "../src/residency-policy.js";

const GB = 1024 ** 3;

const census = (over: Partial<SizeClassCensus> = {}): SizeClassCensus => ({
  sizeClass: "image-large",
  recordCount: 1000,
  totalBytes: 100 * GB,
  bytesWithinDays: { 30: 10 * GB, 90: 25 * GB, 365: 60 * GB },
  ...over,
});

const row = (over: Partial<SizeClassRetention> = {}): SizeClassRetention => ({
  keep: "all",
  budgetBytes: 1000 * GB,
  ...over,
});

describe("what a rule selects", () => {
  it("selects everything for keep: all", () => {
    expect(selectedBytesFor(row({ keep: "all" }), census())).toBe(100 * GB);
  });

  it("selects nothing for keep: never", () => {
    expect(selectedBytesFor(row({ keep: "never" }), census())).toBe(0);
  });

  it("selects the measured cumulative bytes for a recency window", () => {
    expect(selectedBytesFor(row({ keep: "recent-only", recencyWindowDays: 90 }), census())).toBe(
      25 * GB,
    );
  });

  // Interpolating between measured points would be a guess presented as a
  // measurement. Rounding up to the next measured cutoff over-estimates, which
  // is the direction that does not end in a full disk.
  it("rounds up to the next measured cutoff rather than interpolating", () => {
    // 60 days is unmeasured; the answer is the 90-day figure, not something
    // between the 30- and 90-day ones.
    expect(selectedBytesFor(row({ keep: "recent-only", recencyWindowDays: 60 }), census())).toBe(
      25 * GB,
    );
  });

  it("uses the whole library when the window exceeds everything measured", () => {
    expect(selectedBytesFor(row({ keep: "recent-only", recencyWindowDays: 9999 }), census())).toBe(
      60 * GB,
    );
  });

  // A library you actually browse has a working set whose shape is not its
  // calendar — that is the entire reason openedWithinDays exists.
  it("adds the recently-opened working set to the recency window", () => {
    const selected = selectedBytesFor(
      row({ keep: "recent-only", recencyWindowDays: 30, openedWithinDays: 14 }),
      census({ bytesOpenedWithinDays: { 14: 5 * GB } }),
    );
    // Added rather than unioned precisely: the census cannot say how much they
    // overlap, so this over-counts — again in the safe direction.
    expect(selected).toBe(15 * GB);
  });

  it("never selects more than the library holds", () => {
    const selected = selectedBytesFor(
      row({ keep: "recent-only", recencyWindowDays: 365, openedWithinDays: 365 }),
      census({ bytesOpenedWithinDays: { 365: 90 * GB } }),
    );
    expect(selected).toBeLessThanOrEqual(100 * GB);
  });

  // Projecting this as zero would be badly wrong: on-demand caching converges
  // on the working set and fills the row's budget over time, so an operator
  // shown "0 B" would size a disk for a row that grows to 50 GB.
  it("estimates on-demand-only from what has actually been opened", () => {
    const selected = selectedBytesFor(
      row({ keep: "on-demand-only", openedWithinDays: 30 }),
      census({ bytesOpenedWithinDays: { 30: 8 * GB } }),
    );
    expect(selected).toBe(8 * GB);
  });

  it("flags an on-demand row as a floor rather than a settled figure", () => {
    const p = projectRow("image-large", row({ keep: "on-demand-only" }), census());
    expect(p.demandDriven).toBe(true);
    // With nothing measured the honest number is zero — and the flag is what
    // stops the UI presenting that as "this row is free".
    expect(p.projectedBytes).toBe(0);
  });

  it("does not flag the fixed rules as demand-driven", () => {
    for (const keep of ["all", "never", "recent-only"] as const) {
      expect(projectRow("c", row({ keep }), census()).demandDriven, keep).toBe(false);
    }
  });

  it("selects nothing for a recency rule with no window", () => {
    // A misconfiguration rather than an intent; validateRetentionPolicy is
    // where it gets reported, and here it simply selects nothing.
    expect(selectedBytesFor(row({ keep: "recent-only" }), census())).toBe(0);
  });
});

describe("applying the budget", () => {
  it("caps the projection at the budget", () => {
    const p = projectRow("image-large", row({ keep: "all", budgetBytes: 40 * GB }), census());
    expect(p.selectedBytes).toBe(100 * GB);
    expect(p.projectedBytes).toBe(40 * GB);
  });

  // Worth surfacing rather than silently capping: it means eviction runs
  // continuously against this row, and the operator's stated intent is not what
  // they will get.
  it("flags a row whose rule wants more than its budget", () => {
    const p = projectRow("image-large", row({ keep: "all", budgetBytes: 40 * GB }), census());
    expect(p.overBudget).toBe(true);
  });

  it("does not flag a row that fits", () => {
    expect(projectRow("image-large", row({ budgetBytes: 200 * GB }), census()).overBudget).toBe(
      false,
    );
  });

  // Pins win over budgets, so a row can legitimately exceed its own cap. A
  // projection that reported the budget instead would promise a number the
  // engine has already been told it may not deliver.
  it("holds pinned bytes even past the budget", () => {
    const p = projectRow(
      "image-large",
      row({ keep: "never", budgetBytes: 1 * GB }),
      census({ pinnedBytes: 12 * GB }),
    );
    expect(p.projectedBytes).toBe(12 * GB);
    expect(p.pinnedBytes).toBe(12 * GB);
  });
});

describe("projecting a whole policy", () => {
  // Rungs live under an app namespace; the row keys are the rungs alone, and
  // the census names classes fully qualified. Keeping the two straight is the
  // thing this describe block is really checking.
  const withApp = (
    rows: Record<string, SizeClassRetention>,
    totalBudgetBytes = 1000 * GB,
  ): NodeRetentionPolicy => ({
    platform: { rows: {}, fallback: { keep: "never", budgetBytes: 1 * GB } },
    apps: {
      photos: { rows, fallback: { keep: "never", budgetBytes: 1 * GB }, totalBudgetBytes },
    },
    appFallback: {
      rows: {},
      fallback: { keep: "never", budgetBytes: 1 * GB },
      totalBudgetBytes,
    },
  });

  const policy = withApp({
    "image-thumb": { keep: "all", budgetBytes: 5 * GB },
    "image-large": { keep: "recent-only", recencyWindowDays: 90, budgetBytes: 50 * GB },
  });

  const library = [
    census({ sizeClass: "photos:image-thumb", totalBytes: 2 * GB, bytesWithinDays: { 365: 2 * GB } }),
    census({ sizeClass: "photos:image-large" }),
  ];

  it("totals the rows", () => {
    const projection = projectPolicy(policy, library);
    expect(projection.totalProjectedBytes).toBe(2 * GB + 25 * GB);
  });

  it("names the rows that will not fit", () => {
    const tight = withApp({
      "image-thumb": { keep: "all", budgetBytes: 5 * GB },
      "image-large": { keep: "all", budgetBytes: 1 * GB },
    });
    expect(projectPolicy(tight, library).overBudgetClasses).toEqual(["photos:image-large"]);
  });

  // A projection that quietly ignored unlisted classes would under-report
  // exactly the disk use nobody planned for.
  it("applies the fallback to classes the policy does not mention", () => {
    const withExtra = [...library, census({ sizeClass: "photos:video-720p", totalBytes: 80 * GB })];
    const projection = projectPolicy(policy, withExtra);
    const extra = projection.rows.find((r) => r.sizeClass === "photos:video-720p")!;
    // `never` in the fallback, so nothing — but it appears in the table, which
    // is the point: the operator can see the class exists and is being dropped.
    expect(extra.projectedBytes).toBe(0);
    expect(projection.rows).toHaveLength(3);
  });

  // The total is what the app will actually be held to, so the headline figure
  // has to respect it. Summing the rows would promise disk use that the
  // namespace eviction pass is going to take straight back.
  it("caps the total at the app's namespace total rather than summing rows", () => {
    const capped = withApp(
      {
        "image-thumb": { keep: "all", budgetBytes: 5 * GB },
        "image-large": { keep: "recent-only", recencyWindowDays: 90, budgetBytes: 50 * GB },
      },
      10 * GB,
    );
    const projection = projectPolicy(capped, library);
    expect(projection.totalProjectedBytes).toBe(10 * GB);
    expect(projection.overTotalNamespaces).toEqual(["photos"]);
  });

  // The case an operator cannot see from the rows: each one is comfortably
  // inside its budget, and the app as a whole is not.
  it("flags a namespace over its total even when no single row is over", () => {
    const capped = withApp(
      {
        "image-thumb": { keep: "all", budgetBytes: 50 * GB },
        "image-large": { keep: "recent-only", recencyWindowDays: 90, budgetBytes: 50 * GB },
      },
      5 * GB,
    );
    const projection = projectPolicy(capped, library);
    expect(projection.overBudgetClasses).toEqual([]);
    expect(projection.overTotalNamespaces).toEqual(["photos"]);
  });

  it("gives the platform namespace no total to be over", () => {
    const projection = projectPolicy(policy, [
      census({ sizeClass: "starkeep:original:image", totalBytes: 900 * GB }),
    ]);
    const platform = projection.namespaces.find((n) => n.namespace === "starkeep")!;
    expect(platform.totalBudgetBytes).toBeNull();
    expect(platform.overTotal).toBe(false);
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
