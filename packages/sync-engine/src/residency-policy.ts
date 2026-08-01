/**
 * Residency policy — the decision a node makes *before* a blob transfer about
 * whether it wants these bytes at all.
 *
 * The problem this solves is stated in the media plan §6.1: today a missing
 * blob is a *failure*, so the sync engine holds the watermark back and the
 * record is re-shipped forever. There is no way for a node to say "I have the
 * metadata and I am intentionally not fetching the bytes." That single
 * behaviour blocks both a phone node and any archive tier.
 *
 * So: `decideResidency` runs before the pull. `"elide"` applies the metadata,
 * skips the blob, and **advances the watermark** — a declined blob is a
 * legitimate terminal state, not a retry. `"fetch"` that then fails is
 * unchanged: the watermark holds and the next round retries.
 *
 * ## The platform never learns what a size class is
 *
 * Policy rows are keyed by opaque class names. `image-medium` means nothing
 * here; the host supplies a `classifyRecord` function that reads whatever
 * label it uses, and this module only ever compares the resulting string
 * against its own table. That is deliberate and load-bearing: class names and
 * maxima move when the visual test lands and can move again on a respec, and a
 * platform that hard-codes them is a platform that has to be changed on each of
 * those events.
 */

/** What a node does with a given size class. There is no residency-class enum. */
export type KeepRule =
  /** Keep every record of this class that the library contains. */
  | "all"
  /** Keep only what falls in the recency window; decline the rest. */
  | "recent-only"
  /** Never fetch proactively; fetch only when something actually asks for it. */
  | "on-demand-only"
  /** Never hold this class on this node at all. */
  | "never";

/** One row of the §6.2 retention table. */
export interface SizeClassRetention {
  readonly keep: KeepRule;
  /**
   * For `recent-only`: how far back to keep, by the record's own recency
   * signal (capture time where known, else creation). Ignored otherwise.
   */
  readonly recencyWindowDays?: number;
  /**
   * For `recent-only`: also keep anything opened within this many days,
   * regardless of how old it is. A library you actually browse has a working
   * set that is not the same shape as its calendar.
   */
  readonly openedWithinDays?: number;
  /**
   * Cap on this row, in bytes.
   *
   * **No row may be zero.** A zero budget makes the class unreachable offline
   * *and* silently disables the recency rule above it, so re-opening
   * yesterday's photo re-downloads it. If a node genuinely wants none of a
   * class, that is `keep: "never"` — which says so.
   */
  readonly budgetBytes: number;
}

/**
 * A node's whole retention policy: one row per size class.
 *
 * `Full`/`Library`/`Browse`-style presets may front this in the UI, but they
 * **write** these rows rather than being stored — nothing here records which
 * preset produced a table, and no behaviour is conditioned on one.
 */
export interface NodeRetentionPolicy {
  readonly rows: Readonly<Record<string, SizeClassRetention>>;
  /**
   * Applied to records whose class the host could not resolve. Defaults to
   * fetching: a node that cannot classify something should not silently
   * decline it, because the failure mode of over-fetching is a full disk and
   * the failure mode of under-fetching is data that quietly isn't anywhere.
   */
  readonly fallback: SizeClassRetention;
}

/**
 * Constraints carried *on the record*, honoured identically by every node.
 * This is the restrictive tier: nothing below may override it.
 */
export interface RecordConstraints {
  /**
   * The record's own constraints forbid these bytes being held *on this node*.
   *
   * Phrased about this node rather than naming a specific rule, because the
   * rules are not symmetric: `starkeep/no-cloud` forbids the cloud node and
   * says nothing about a laptop. "Honoured identically by every node" means
   * every node evaluates the same constraint against its own identity and
   * reaches the answer the constraint intends — not that every node reaches
   * the same answer.
   *
   * The host computes this, because only it knows which node it is. And
   * because a fetch-time decision cannot stop an inbound *push*, any
   * constraint that must actually hold also needs a server-side refusal.
   */
  readonly deniedHere: boolean;
}

/** Node-local per-record state. Travels with nothing. */
export interface LocalOverrides {
  /**
   * This node wants these bytes regardless of budget. Pins **win** — otherwise
   * someone pins 200 GB into a small budget and eviction thrashes forever.
   * They still count against the class's budget, so the overage is visible
   * rather than swallowed.
   */
  readonly pinned: boolean;
}

/** Normalized view of the thing whose blob is about to move. */
export interface BlobCandidate {
  readonly recordId: string;
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
  /** Canonical Starkeep type, or null for app-syncable rows. */
  readonly type: string | null;
  readonly parentId: string | null;
  /** Owning app for an app-syncable row; null for shared records. */
  readonly appId: string | null;
  /**
   * The record's own recency signal in epoch ms — capture time where the host
   * knows it, else creation. Null when unknown, which makes `recent-only`
   * fetch rather than decline: an unknown date is not evidence of age.
   */
  readonly recencyAtMs: number | null;
  /** Epoch ms this record was last opened on this node, if ever. */
  readonly lastOpenedAtMs: number | null;
}

export type ResidencyDecision = "fetch" | "elide";

/** Why a decision came out the way it did — for the residency inspector. */
export interface ResidencyVerdict {
  readonly decision: ResidencyDecision;
  /** The class the host resolved, or null if it could not. */
  readonly sizeClass: string | null;
  readonly reason:
    | "record-constraint"
    | "pinned"
    | "keep-all"
    | "keep-never"
    | "on-demand-only"
    | "outside-recency-window"
    | "within-recency-window"
    | "budget-exhausted"
    | "unclassified";
}

/** How many bytes this node currently holds for a class. Supplied by the host. */
export type ClassUsageLookup = (sizeClass: string | null) => number;

export interface DecideResidencyInputs {
  readonly candidate: BlobCandidate;
  readonly sizeClass: string | null;
  readonly policy: NodeRetentionPolicy;
  readonly constraints: RecordConstraints;
  readonly overrides: LocalOverrides;
  readonly usage: ClassUsageLookup;
  /** Injected for testability; defaults to `Date.now()`. */
  readonly nowMs?: number;
}

/**
 * The decision, in the fixed order of §6.1. The order matters because two of
 * the inputs pull in opposite directions: a record constraint says "nobody may
 * hold this here" and a pin says "this node insists on holding it".
 * Restrictive wins, and it wins first.
 */
export function decideResidency(inputs: DecideResidencyInputs): ResidencyVerdict {
  const { candidate, sizeClass, policy, constraints, overrides, usage } = inputs;
  const now = inputs.nowMs ?? Date.now();

  // 1. Record constraints — carried on the record, honoured identically
  //    everywhere. Nothing below may override.
  if (constraints.deniedHere) {
    return { decision: "elide", sizeClass, reason: "record-constraint" };
  }

  // 2. Local pin. Beats every budget and recency rule, and deliberately does
  //    not beat step 1.
  if (overrides.pinned) {
    return { decision: "fetch", sizeClass, reason: "pinned" };
  }

  // 3. The node's rule for this record's class, then that class's budget.
  const row = sizeClass === null ? policy.fallback : (policy.rows[sizeClass] ?? policy.fallback);
  const unclassified = sizeClass === null || policy.rows[sizeClass] === undefined;

  if (row.keep === "never") {
    return { decision: "elide", sizeClass, reason: "keep-never" };
  }
  if (row.keep === "on-demand-only") {
    // Not a failure and not a permanent refusal — an explicit fetch (a user
    // opening the item) still gets the bytes. It just never happens as part of
    // a sync round.
    return { decision: "elide", sizeClass, reason: "on-demand-only" };
  }

  if (row.keep === "recent-only" && !withinRecencyWindow(candidate, row, now)) {
    return { decision: "elide", sizeClass, reason: "outside-recency-window" };
  }

  // Budget. Checked last so that a class the node has decided to keep is only
  // declined for want of room, never for want of interest.
  if (usage(sizeClass) + candidate.sizeBytes > row.budgetBytes) {
    return { decision: "elide", sizeClass, reason: "budget-exhausted" };
  }

  if (unclassified) {
    return { decision: "fetch", sizeClass, reason: "unclassified" };
  }
  return {
    decision: "fetch",
    sizeClass,
    reason: row.keep === "all" ? "keep-all" : "within-recency-window",
  };
}

function withinRecencyWindow(
  candidate: BlobCandidate,
  row: SizeClassRetention,
  nowMs: number,
): boolean {
  const dayMs = 24 * 60 * 60 * 1000;

  if (row.openedWithinDays !== undefined && candidate.lastOpenedAtMs !== null) {
    if (nowMs - candidate.lastOpenedAtMs <= row.openedWithinDays * dayMs) return true;
  }

  // An unknown date is not evidence of age. Declining on missing metadata
  // would make a metadata gap silently cost you the bytes.
  if (candidate.recencyAtMs === null) return true;

  if (row.recencyWindowDays === undefined) return true;
  return nowMs - candidate.recencyAtMs <= row.recencyWindowDays * dayMs;
}

/**
 * Reject policies that can't mean what they say. Called by hosts when a policy
 * is set, so a bad table is refused at the point of configuration rather than
 * quietly declining blobs forever.
 */
export function validateRetentionPolicy(policy: NodeRetentionPolicy): string[] {
  const problems: string[] = [];
  for (const [name, row] of Object.entries(policy.rows)) {
    problems.push(...validateRow(name, row));
  }
  problems.push(...validateRow("(fallback)", policy.fallback));
  return problems;
}

function validateRow(name: string, row: SizeClassRetention): string[] {
  const problems: string[] = [];
  // "never" is the honest way to want none of a class. A zero budget is the
  // dishonest way: it reads as a limit and behaves as a prohibition, and it
  // silently disables the recency rule sitting above it.
  if (row.keep !== "never" && row.budgetBytes <= 0) {
    problems.push(
      `${name}: budgetBytes must be > 0 for keep="${row.keep}" — use keep:"never" to hold none of a class`,
    );
  }
  if (row.keep === "recent-only" && row.recencyWindowDays === undefined && row.openedWithinDays === undefined) {
    problems.push(`${name}: keep="recent-only" needs recencyWindowDays and/or openedWithinDays`);
  }
  return problems;
}
