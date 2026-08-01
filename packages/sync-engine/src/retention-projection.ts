/**
 * Projecting what a retention policy will actually cost on disk (item 34).
 *
 * ## Why a projection rather than a live figure
 *
 * The matrix is edited *before* it takes effect. An operator moving
 * `image-large` from `never` to `all` needs to know it will cost 40 GB **while
 * they are deciding**, not after the sync engine has spent a night fetching.
 * The whole value of the row is answering "what happens if I do this", and a
 * UI that only reported current usage would answer a different question.
 *
 * ## Projected against a census, not a guess
 *
 * Every number below comes from counting what the library actually holds — how
 * many records fall in each class, their real total bytes, and how they
 * distribute over time. Multiplying an average size by a record count would be
 * simpler and would be wrong in the direction that matters: rendition sizes are
 * per-record maxima, so a library of screenshots and a library of ProRAW have
 * wildly different totals for identical counts, and the operator whose estimate
 * was built on the wrong assumption discovers it as a full disk.
 */

import type { NodeRetentionPolicy, SizeClassRetention } from "./residency-policy.js";

/**
 * What the library actually contains for one size class, measured.
 *
 * `bytesWithinDays` is cumulative: the bytes of every record at least as recent
 * as each cutoff. Cumulative rather than bucketed because that is the shape the
 * question takes — "keep the last 90 days" is a prefix, not a bucket — and
 * deriving one from the other at read time invites an off-by-one at exactly the
 * boundary the operator is looking at.
 */
export interface SizeClassCensus {
  readonly sizeClass: string;
  readonly recordCount: number;
  readonly totalBytes: number;
  /** Cutoff days → cumulative bytes of records at least that recent. */
  readonly bytesWithinDays: Readonly<Record<number, number>>;
  /** Bytes of records opened recently, keyed the same way. */
  readonly bytesOpenedWithinDays?: Readonly<Record<number, number>>;
  /** Bytes pinned on this node, which are kept whatever the row says. */
  readonly pinnedBytes?: number;
}

export interface RowProjection {
  readonly sizeClass: string;
  /** What the rule selects, before the budget is applied. */
  readonly selectedBytes: number;
  /** What will actually be held, after the budget caps it. */
  readonly projectedBytes: number;
  readonly budgetBytes: number;
  /**
   * True when the rule selects more than the budget allows.
   *
   * Worth surfacing rather than silently capping: it means eviction will run
   * continuously against this row, and the operator's stated intent ("keep the
   * last year") is not what they will get.
   */
  readonly overBudget: boolean;
  /**
   * Bytes that are pinned and therefore held even past the budget.
   *
   * Reported separately because pins **win** over budgets — so a row can exceed
   * its own cap legitimately, and an operator seeing that needs to know it is
   * pins rather than a bug.
   */
  readonly pinnedBytes: number;
  /**
   * True for `on-demand-only`, where the number is a floor rather than a
   * settled figure: the row holds whatever has been asked for, and grows
   * toward its budget as the library is browsed.
   *
   * Flagged rather than folded into the number because presenting a
   * demand-driven row as a fixed projection is how an operator budgets a disk
   * for a figure that then doubles.
   */
  readonly demandDriven: boolean;
}

export interface PolicyProjection {
  readonly rows: readonly RowProjection[];
  readonly totalProjectedBytes: number;
  /** Rows whose rule selects more than their budget. */
  readonly overBudgetClasses: readonly string[];
}

/**
 * The bytes a single row's rule selects, ignoring its budget.
 *
 * The interpolation question is deliberately not answered by interpolating. If
 * the census has no measurement at the requested cutoff, the **next larger**
 * available cutoff is used, which over-estimates. Over-estimating is the safe
 * direction here: an operator who is told a row costs more than it does buys a
 * bigger disk, while one told it costs less runs out of space and starts
 * evicting things they asked to keep.
 */
export function selectedBytesFor(row: SizeClassRetention, census: SizeClassCensus): number {
  switch (row.keep) {
    case "never":
      return 0;
    case "all":
      return census.totalBytes;
    case "on-demand-only":
      // Nothing is fetched *proactively*, so a naive projection would say zero
      // — and be badly wrong. On-demand caching converges on the working set,
      // and over time fills the row's budget. The best measured estimate of
      // that steady state is what has actually been opened recently; with no
      // such measurement the honest answer is zero, and `demandDriven` on the
      // projection is what tells the UI to say "grows to the budget as you
      // browse" rather than presenting the number as a settled figure.
      return row.openedWithinDays && census.bytesOpenedWithinDays
        ? Math.min(cumulativeAt(census.bytesOpenedWithinDays, row.openedWithinDays), census.totalBytes)
        : 0;
    case "recent-only": {
      const windowDays = row.recencyWindowDays ?? 0;
      // A recent-only row with no window keeps nothing by its recency rule —
      // which is a misconfiguration rather than an intent, and validateRetentionPolicy
      // is where it gets reported. Here it simply selects nothing.
      let bytes = windowDays > 0 ? cumulativeAt(census.bytesWithinDays, windowDays) : 0;
      // The working set. A library you actually browse has a shape that is not
      // its calendar, so this is a union with the recency window rather than a
      // separate row — and unions are added because the census cannot say how
      // much they overlap. That over-counts, in the safe direction.
      if (row.openedWithinDays && census.bytesOpenedWithinDays) {
        bytes += cumulativeAt(census.bytesOpenedWithinDays, row.openedWithinDays);
      }
      return Math.min(bytes, census.totalBytes);
    }
  }
}

/**
 * Read a cumulative census at a cutoff, rounding *up* to a measured point.
 *
 * Falls back to the largest available measurement when the requested cutoff is
 * beyond everything measured — which is the whole library, and correct.
 */
function cumulativeAt(measurements: Readonly<Record<number, number>>, cutoffDays: number): number {
  const points = Object.keys(measurements)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (points.length === 0) return 0;
  const atOrAbove = points.find((p) => p >= cutoffDays);
  const chosen = atOrAbove ?? points[points.length - 1]!;
  return measurements[chosen] ?? 0;
}

export function projectRow(
  sizeClass: string,
  row: SizeClassRetention,
  census: SizeClassCensus,
): RowProjection {
  const selectedBytes = selectedBytesFor(row, census);
  const pinnedBytes = census.pinnedBytes ?? 0;
  // Pins win over budgets, so the floor is the pinned bytes even when the
  // budget is smaller — otherwise the projection would promise a number the
  // engine has already been told it may not deliver.
  const projectedBytes = Math.max(Math.min(selectedBytes, row.budgetBytes), pinnedBytes);
  return {
    sizeClass,
    selectedBytes,
    projectedBytes,
    budgetBytes: row.budgetBytes,
    overBudget: selectedBytes > row.budgetBytes,
    pinnedBytes,
    demandDriven: row.keep === "on-demand-only",
  };
}

/**
 * Project a whole policy against a census.
 *
 * Classes present in the census but absent from the policy fall to
 * `policy.fallback` — the same rule the engine applies, so the projection
 * cannot disagree with what actually happens. A projection that quietly ignored
 * unlisted classes would under-report exactly the disk use nobody planned for.
 */
export function projectPolicy(
  policy: NodeRetentionPolicy,
  census: readonly SizeClassCensus[],
): PolicyProjection {
  const rows = census.map((c) =>
    projectRow(c.sizeClass, policy.rows[c.sizeClass] ?? policy.fallback, c),
  );
  return {
    rows,
    totalProjectedBytes: rows.reduce((sum, r) => sum + r.projectedBytes, 0),
    overBudgetClasses: rows.filter((r) => r.overBudget).map((r) => r.sizeClass),
  };
}

/**
 * Human-readable bytes for the matrix.
 *
 * Binary units, because this is disk space and every OS the operator will check
 * it against reports the same way — a UI saying 40 GB beside a Finder saying
 * 37.2 GB reads as a bug in the UI.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  // A whole number shows as one. "1.0 GiB" reads as a computed approximation of
  // something near a gigabyte, when it is exactly a gigabyte.
  const exact = Number.isInteger(value);
  return `${exact || value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
