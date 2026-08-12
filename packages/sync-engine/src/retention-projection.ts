/**
 * Projecting what a retention policy will actually cost on disk (item 34).
 *
 * ## Why a projection rather than a live figure
 *
 * The matrix is edited *before* it takes effect. An operator raising
 * `image-large`'s share needs to know it will cost 40 GB **while they are
 * deciding**, not after the sync engine has spent a night fetching. The whole
 * value of the row is answering "what happens if I do this", and a UI that only
 * reported current usage would answer a different question.
 *
 * ## Projected against a census, not a guess
 *
 * Every number below comes from counting what the library actually holds — how
 * many records fall in each class and their real total bytes. Multiplying an
 * average size by a record count would be simpler and would be wrong in the
 * direction that matters: rendition sizes are per-record maxima, so a library of
 * screenshots and a library of ProRAW have wildly different totals for identical
 * counts, and the operator whose estimate was built on the wrong assumption
 * discovers it as a full disk.
 *
 * ## Why this got much smaller
 *
 * It used to project a recency axis: cumulative bytes at each of seven cutoffs,
 * a union of two windows added together because the census could not say how
 * much they overlapped, and a documented over-count in the safe direction. All
 * of that was estimating how much a hand-written date rule would select. There
 * is no date rule now — a class either gets pulled or it does not, and the
 * budget decides the rest — so the projection is what a class contains against
 * what its share allows, with no estimation in between.
 */

import {
  budgetBytesFor,
  budgetLineFor,
  namespaceRetentionFor,
  parseSizeClass,
  retentionRowFor,
  PLATFORM_NAMESPACE,
  type NodeRetentionPolicy,
} from "./residency-policy.js";

/** What the library actually contains for one size class, measured. */
export interface SizeClassCensus {
  readonly sizeClass: string;
  readonly recordCount: number;
  readonly totalBytes: number;
  /** Bytes pinned on this node, which are kept whatever the row says. */
  readonly pinnedBytes?: number;
}

export interface RowProjection {
  readonly sizeClass: string;
  /** The budget line this class is charged to. Several classes may share one. */
  readonly budgetLineKey: string;
  /** What the rule selects, before the budget is applied. */
  readonly selectedBytes: number;
  /** What will actually be held, after the budget caps it. */
  readonly projectedBytes: number;
  /**
   * The line's budget in bytes, resolved from its share of the namespace.
   *
   * Derived rather than stored, which is the point: an operator moves a share
   * or the namespace total and every row's bytes follow, so the numbers in this
   * table cannot add up to something other than the total.
   */
  readonly budgetBytes: number;
  /**
   * True when the class contains more than its line's budget allows.
   *
   * Worth surfacing rather than silently capping: it means eviction will run
   * against this line, and the operator should know the class is being held at
   * its best rather than in full.
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
   * True when the class is not prefetched, where the number is a floor rather
   * than a settled figure: the line holds whatever has been asked for, and
   * grows toward its budget as the library is browsed.
   *
   * Flagged rather than folded into the number because presenting a
   * demand-driven row as a fixed projection is how an operator budgets a disk
   * for a figure that then doubles.
   */
  readonly demandDriven: boolean;
}

/**
 * One namespace's roll-up, and the budget the whole of it is divided from.
 *
 * Still its own line in the table, but it now reports a *division* rather than
 * a second cap. An app's rows used to carry absolute byte counts with a
 * separate total beside them, and the two could disagree — in the shipped phone
 * policy they did, by 240 MB. Shares make the rows sum to the total by
 * construction, so what this line says is "here is the number, and here is what
 * your library will actually put in it".
 */
export interface NamespaceProjection {
  readonly namespace: string;
  readonly totalBudgetBytes: number;
  /** What this namespace's classes contain, before any budget. */
  readonly selectedBytes: number;
  /** What the rows alone would hold. */
  readonly rowProjectedBytes: number;
  /** What will actually be held. */
  readonly projectedBytes: number;
  /**
   * True when the namespace will hold more than its budget.
   *
   * Under shares this can only be pins: the lines sum to the total, so nothing
   * else can push a namespace past it. That makes the flag *more* informative
   * than it was — it now names one cause instead of two.
   */
  readonly overTotal: boolean;
}

export interface PolicyProjection {
  readonly rows: readonly RowProjection[];
  readonly namespaces: readonly NamespaceProjection[];
  readonly totalProjectedBytes: number;
  /** Classes containing more than their line's budget. */
  readonly overBudgetClasses: readonly string[];
  /** Namespaces that will hold more than their budget, i.e. because of pins. */
  readonly overTotalNamespaces: readonly string[];
}

/**
 * Project a whole policy against a census.
 *
 * Classes present in the census but absent from the policy resolve through
 * `budgetLineFor` — the same resolution the engine applies, so the projection
 * cannot disagree with what actually happens. A projection that quietly ignored
 * unlisted classes would under-report exactly the disk use nobody planned for.
 *
 * ## Classes sharing a line are capped together, not each
 *
 * Every unrecognised rung of a namespace pools onto one budget line, so a
 * projection that capped each of them at the line's budget would report the
 * line's capacity several times over — the same over-report that made rung
 * invention free in the first place. The budget is therefore distributed across
 * the classes on a line in proportion to what each contains, which is what the
 * eviction ordering will approximately do to them anyway.
 */
export function projectPolicy(
  policy: NodeRetentionPolicy,
  census: readonly SizeClassCensus[],
): PolicyProjection {
  // Group first: a row's cap depends on what else shares its line.
  const byLine = new Map<string, SizeClassCensus[]>();
  for (const entry of census) {
    const key = budgetLineFor(policy, parseSizeClass(entry.sizeClass)).key;
    byLine.set(key, [...(byLine.get(key) ?? []), entry]);
  }

  const rows: RowProjection[] = [];
  for (const [budgetLineKey, entries] of byLine) {
    const budgetLine = { ...parsedLine(budgetLineKey) };
    const row = retentionRowFor(policy, budgetLine);
    const lineBudget = budgetBytesFor(policy, budgetLine);
    const lineTotal = entries.reduce((sum, c) => sum + c.totalBytes, 0);

    for (const entry of entries) {
      const selectedBytes = entry.totalBytes;
      const pinnedBytes = entry.pinnedBytes ?? 0;
      // This class's slice of a possibly shared line. One class on the line is
      // the ordinary case and gets the whole of it; several split it by what
      // they hold, so the line's projected total is the line's budget rather
      // than a multiple of it.
      const budgetBytes =
        entries.length === 1 || lineTotal <= 0
          ? lineBudget
          : Math.floor((lineBudget * selectedBytes) / lineTotal);
      // Pins win over budgets, so the floor is the pinned bytes even when the
      // budget is smaller — otherwise the projection would promise a number the
      // engine has already been told it may not deliver.
      rows.push({
        sizeClass: entry.sizeClass,
        budgetLineKey,
        selectedBytes,
        projectedBytes: Math.max(Math.min(selectedBytes, budgetBytes), pinnedBytes),
        budgetBytes,
        overBudget: selectedBytes > budgetBytes,
        pinnedBytes,
        demandDriven: !row.prefetch,
      });
    }
  }

  // A class name from before namespacing has no namespace to group under.
  // Grouped with the platform, matching where `budgetLineFor` sends it.
  const byNamespace = new Map<string, RowProjection[]>();
  for (const row of rows) {
    const namespace = parseSizeClass(row.sizeClass)?.namespace ?? PLATFORM_NAMESPACE;
    byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), row]);
  }

  const namespaces: NamespaceProjection[] = [...byNamespace.entries()].map(
    ([namespace, group]) => {
      const totalBudgetBytes = namespaceRetentionFor(policy, namespace).budgetBytes;
      const selectedBytes = group.reduce((sum, r) => sum + r.selectedBytes, 0);
      const rowProjectedBytes = group.reduce((sum, r) => sum + r.projectedBytes, 0);
      return {
        namespace,
        totalBudgetBytes,
        selectedBytes,
        rowProjectedBytes,
        // No second cap to apply. The rows are shares of this number, so their
        // sum cannot exceed it except by pins — which are already in each row's
        // projection, and must stay there rather than being capped away.
        projectedBytes: rowProjectedBytes,
        overTotal: rowProjectedBytes > totalBudgetBytes,
      };
    },
  );

  return {
    rows,
    namespaces,
    totalProjectedBytes: namespaces.reduce((sum, n) => sum + n.projectedBytes, 0),
    overBudgetClasses: rows.filter((r) => r.overBudget).map((r) => r.sizeClass),
    overTotalNamespaces: namespaces.filter((n) => n.overTotal).map((n) => n.namespace),
  };
}

/**
 * A stored line key back into its halves.
 *
 * The same first-colon split `parseSizeClass` uses, and for the same reason: a
 * platform rung is itself `original:image`. A key with no separator cannot name
 * a namespace, so it goes to the platform's pooled line — where an unresolvable
 * class has always gone.
 */
function parsedLine(key: string): { namespace: string; rung: string; key: string } {
  const parsed = parseSizeClass(key);
  return parsed === null
    ? { namespace: PLATFORM_NAMESPACE, rung: key, key }
    : { namespace: parsed.namespace, rung: parsed.rung, key };
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
