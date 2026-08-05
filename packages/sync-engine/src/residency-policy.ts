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
 *
 * ## Classes are namespaced by the app that produced the bytes
 *
 * A class name alone was ambiguous the moment a second app derived anything:
 * one app's ladder was legible and everyone else's derivatives fell through to
 * the fallback and were treated as originals — the most protected tier. So a
 * class is now a **namespace and a rung**, `photos:image-medium`, and the two
 * halves answer different questions:
 *
 *   - The **namespace** says whose bytes these are, and an app cannot choose it
 *     — the host derives it from structure (does this record have a parent?)
 *     and from server-set identity (which app wrote the label?).
 *   - The **rung** says which step of that app's ladder this is, and the app
 *     names it freely inside its own namespace.
 *
 * The rule that falls out, and the one worth remembering: **a label picks the
 * rung, never the namespace.** An app therefore cannot promote an original into
 * a cheap rung, cannot demote a rendition into the protected tier, and cannot
 * spend another app's budget. The one thing it can still do — invent rung names
 * to escape into a fallback row — is what {@link AppRetention.totalBudgetBytes}
 * bounds.
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
 * The namespace holding classes no app may write into: the records that are the
 * thing itself rather than something derived from it.
 *
 * Named for the platform rather than left blank so that every class name has
 * the same shape, and so an app id can never be confused for it — app ids and
 * this constant share one namespace, and `starkeep` is already reserved as the
 * platform's label app id (`STARKEEP_LABEL_APP_ID`).
 */
export const PLATFORM_NAMESPACE = "starkeep";

/**
 * A size class, resolved into the two halves that mean different things.
 *
 * Carried as a resolved object rather than re-parsed at each use. The qualified
 * string is what gets stored and displayed; the split is what gets *decided*
 * on, and a decision that re-derives the namespace by string surgery is one
 * rename away from charging an app's bytes to the platform's budget.
 */
export interface ResolvedSizeClass {
  /** Whose bytes these are. Never chosen by the app itself. */
  readonly namespace: string;
  /** Which rung of that namespace's ladder. Named by the app, inside its own namespace. */
  readonly rung: string;
  /** `<namespace>:<rung>` — the resident-set key and the name an operator sees. */
  readonly qualified: string;
}

export function resolveSizeClass(namespace: string, rung: string): ResolvedSizeClass {
  return { namespace, rung, qualified: `${namespace}:${rung}` };
}

/**
 * Split a stored class name back into its halves.
 *
 * Splits at the **first** colon only: a platform rung is itself `original:image`,
 * and an app is free to put colons in a rung name. Everything after the first
 * separator belongs to the rung.
 *
 * Returns null for a string with no separator at all, which is a pre-namespacing
 * class name. Callers treat that as unresolvable rather than guessing a
 * namespace for it — guessing would land it in whichever budget the guess named.
 */
export function parseSizeClass(qualified: string): ResolvedSizeClass | null {
  const separator = qualified.indexOf(":");
  if (separator <= 0 || separator === qualified.length - 1) return null;
  return {
    namespace: qualified.slice(0, separator),
    rung: qualified.slice(separator + 1),
    qualified,
  };
}

export function isPlatformClass(sizeClass: ResolvedSizeClass): boolean {
  return sizeClass.namespace === PLATFORM_NAMESPACE;
}

/** One app's namespace: its rungs, and the cap across all of them. */
export interface AppRetention {
  /** Rungs this app declares, keyed by the label value. */
  readonly rows: Readonly<Record<string, SizeClassRetention>>;
  /** Applied to a rung with no row — an unknown or invented rung name. */
  readonly fallback: SizeClassRetention;
  /**
   * Cap across every rung of this app, enforced *in addition* to the rows.
   *
   * This is what makes rung invention safe. Without it, an app that names a
   * thousand rungs gets a thousand fallback budgets; with it, it still cannot
   * exceed one number.
   */
  readonly totalBudgetBytes: number;
}

/**
 * A node's whole retention policy: platform classes, then one namespace per app.
 *
 * Two levels rather than one flat table because the requirement is a budget
 * *per app* and per classification within the app, and a flat table can only
 * express the second. It also puts the one boundary that matters — platform
 * versus app — in the structure rather than in a naming convention.
 *
 * `Full`/`Library`/`Browse`-style presets may front this in the UI, but they
 * **write** these rows rather than being stored — nothing here records which
 * preset produced a table, and no behaviour is conditioned on one.
 */
export interface NodeRetentionPolicy {
  /**
   * Platform-owned classes — the originals. No app can write here, because
   * membership is decided by the record having no parent rather than by any
   * label. Keyed `original:<category>`.
   */
  readonly platform: {
    readonly rows: Readonly<Record<string, SizeClassRetention>>;
    /**
     * Applied to a platform class with no row. Defaults to fetching: a node
     * that cannot classify something should not silently decline it, because
     * the failure mode of over-fetching is a full disk and the failure mode of
     * under-fetching is data that quietly isn't anywhere.
     */
    readonly fallback: SizeClassRetention;
  };
  /** Per-app namespaces, keyed by appId. */
  readonly apps: Readonly<Record<string, AppRetention>>;
  /**
   * Applied to an app with no entry above — one the operator has never
   * configured, which is the ordinary state right after installing something.
   */
  readonly appFallback: AppRetention;
}

/**
 * The namespace's whole budget, for the app-total check.
 *
 * The platform namespace has no total: its rows *are* the originals, and a cap
 * above them would be a second way to say the same thing that could disagree
 * with the first. So it returns null and the total check is skipped.
 */
export function namespaceTotalFor(
  policy: NodeRetentionPolicy,
  namespace: string,
): number | null {
  if (namespace === PLATFORM_NAMESPACE) return null;
  return (policy.apps[namespace] ?? policy.appFallback).totalBudgetBytes;
}

/**
 * The row governing one class, through both levels.
 *
 * A class in an unconfigured app's namespace falls to `appFallback.fallback`,
 * not to the platform fallback: an app nobody has budgeted for must not inherit
 * the rule written for originals.
 */
export function retentionRowFor(
  policy: NodeRetentionPolicy,
  sizeClass: ResolvedSizeClass | null,
): SizeClassRetention {
  if (sizeClass === null) return policy.platform.fallback;
  if (isPlatformClass(sizeClass)) {
    return policy.platform.rows[sizeClass.rung] ?? policy.platform.fallback;
  }
  const app = policy.apps[sizeClass.namespace] ?? policy.appFallback;
  return app.rows[sizeClass.rung] ?? app.fallback;
}

/** Whether the policy names this exact class, as opposed to falling back to it. */
export function hasRowFor(policy: NodeRetentionPolicy, sizeClass: ResolvedSizeClass | null): boolean {
  if (sizeClass === null) return false;
  if (isPlatformClass(sizeClass)) return policy.platform.rows[sizeClass.rung] !== undefined;
  return policy.apps[sizeClass.namespace]?.rows[sizeClass.rung] !== undefined;
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
   * The app that created this shared record (`shared_records.origin_app_id`),
   * or null where the caller had only a transfer manifest to go on.
   *
   * Read but never trusted as a *choice*: it is set from the authenticated
   * writer at record creation, so an app cannot claim another's identity with
   * it. It is the last resort for naming a derivative's namespace when no app
   * has labelled it with a rung — without it such a record would have to be
   * either guessed into someone's budget or treated as an original.
   */
  readonly originAppId: string | null;
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
  readonly sizeClass: ResolvedSizeClass | null;
  readonly reason:
    | "record-constraint"
    | "pinned"
    | "keep-all"
    | "keep-never"
    | "on-demand-only"
    | "outside-recency-window"
    | "within-recency-window"
    | "budget-exhausted"
    // The class's own row had room, but its app has spent its whole namespace
    // total. Reported distinctly because the fix is a different number: raising
    // the row does nothing until the total moves.
    | "namespace-budget-exhausted"
    | "unclassified"
    // Not a decision this module made. `SyncEngine.fetchBlob` answers a direct
    // request and is deliberately not subject to the policy, but the arrival
    // still has to be charged to a budget — so it reports a verdict it did not
    // ask for, named so the residency inspector does not read it as one.
    | "explicit-request";
}

/** How many bytes this node currently holds for a class. Supplied by the host. */
export type ClassUsageLookup = (sizeClass: ResolvedSizeClass | null) => number;

/** How many bytes this node currently holds across a whole namespace. */
export type NamespaceUsageLookup = (namespace: string) => number;

export interface DecideResidencyInputs {
  readonly candidate: BlobCandidate;
  readonly sizeClass: ResolvedSizeClass | null;
  readonly policy: NodeRetentionPolicy;
  readonly constraints: RecordConstraints;
  readonly overrides: LocalOverrides;
  readonly usage: ClassUsageLookup;
  readonly namespaceUsage: NamespaceUsageLookup;
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
  const { candidate, sizeClass, policy, constraints, overrides, usage, namespaceUsage } = inputs;
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
  const row = retentionRowFor(policy, sizeClass);
  const unclassified = !hasRowFor(policy, sizeClass);

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

  // The namespace total, on top of the row. A fetch must fit **both** — the
  // restrictive one wins, as everywhere else in this function. This is the
  // check that makes an unrecognised rung cheap instead of free: the fallback
  // row above it is per-rung, so an app naming a thousand rungs would otherwise
  // get a thousand budgets.
  const namespaceTotal = sizeClass === null ? null : namespaceTotalFor(policy, sizeClass.namespace);
  if (
    sizeClass !== null &&
    namespaceTotal !== null &&
    namespaceUsage(sizeClass.namespace) + candidate.sizeBytes > namespaceTotal
  ) {
    return { decision: "elide", sizeClass, reason: "namespace-budget-exhausted" };
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

  // Structure first, and defensively: a policy arrives as JSON from a config
  // file or a PUT body, where the type above is a claim rather than a
  // guarantee. Reaching into a missing section would throw a TypeError out of
  // the function whose entire job is to turn bad policies into sentences — and
  // the caller that catches it is a node refusing to boot with a stack trace
  // instead of a node saying which part of its policy is missing.
  for (const [name, present] of [
    ["platform", isObject(policy?.platform) && isObject(policy.platform.rows)],
    ["apps", isObject(policy?.apps)],
    ["appFallback", isObject(policy?.appFallback) && isObject(policy.appFallback.rows)],
  ] as const) {
    if (!present) problems.push(`${name}: missing or not an object`);
  }
  if (problems.length > 0) return problems;

  for (const [rung, row] of Object.entries(policy.platform.rows)) {
    problems.push(...validateRow(`${PLATFORM_NAMESPACE}:${rung}`, row));
  }
  problems.push(...validateRow(`${PLATFORM_NAMESPACE} (fallback)`, policy.platform.fallback));

  for (const [appId, app] of Object.entries(policy.apps)) {
    problems.push(...validateApp(appId, app));
    // An app id that collides with the platform namespace would write rows
    // nothing can ever read: the resolution above sends every platform class to
    // `policy.platform`, so this whole entry would sit there being ignored.
    if (appId === PLATFORM_NAMESPACE) {
      problems.push(
        `apps.${appId}: "${PLATFORM_NAMESPACE}" is the platform namespace — its rows belong in platform.rows, and here they are unreachable`,
      );
    }
  }
  problems.push(...validateApp("(unconfigured apps)", policy.appFallback));

  return problems;
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * A budget is a finite number of bytes, and this is the test for that.
 *
 * `<= 0` on its own is not it. A policy is JSON, so a budget can arrive
 * missing or unparseable, and both `undefined <= 0` and `NaN <= 0` are false —
 * a check written that way passes exactly the values that mean nothing. What
 * follows is worse than a policy nobody validated: every comparison the number
 * takes part in is false too, so `bytesBefore <= budget * high` does not hold
 * and the eviction pass triggers, then `held <= target` does not hold either
 * and it never stops. One absent field empties the budget it governs.
 */
function isUsableBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateApp(appId: string, app: AppRetention): string[] {
  if (!isObject(app) || !isObject(app.rows)) return [`${appId}: missing or malformed rows`];

  const problems: string[] = [];
  for (const [rung, row] of Object.entries(app.rows)) {
    problems.push(...validateRow(`${appId}:${rung}`, row));
  }
  problems.push(...validateRow(`${appId} (fallback)`, app.fallback));

  // Zero is refused here for the same reason it is refused on a row, and it
  // matters more: a zero total is a prohibition on every rung the app has,
  // including ones whose rows say "keep everything". An app that should hold
  // nothing is expressed by its rows saying so.
  //
  // A *missing* total is refused for a different and sharper reason — see
  // {@link isUsableBudget}. There is no such thing as an app with no total:
  // the total is what bounds an app that invents rung names, so an entry
  // without one is the hole this whole level exists to close.
  if (!isUsableBudget(app.totalBudgetBytes)) {
    problems.push(
      `${appId}: totalBudgetBytes must be > 0 and finite (got ${String(app.totalBudgetBytes)}) — a missing or zero total silently overrides every row in the namespace`,
    );
  }
  return problems;
}

function validateRow(name: string, row: SizeClassRetention): string[] {
  const problems: string[] = [];
  // "never" is the honest way to want none of a class. A zero budget is the
  // dishonest way: it reads as a limit and behaves as a prohibition, and it
  // silently disables the recency rule sitting above it.
  if (row.keep !== "never" && !isUsableBudget(row.budgetBytes)) {
    problems.push(
      `${name}: budgetBytes must be > 0 for keep="${row.keep}" (got ${String(row.budgetBytes)}) — use keep:"never" to hold none of a class`,
    );
  }
  if (row.keep === "recent-only" && row.recencyWindowDays === undefined && row.openedWithinDays === undefined) {
    problems.push(`${name}: keep="recent-only" needs recencyWindowDays and/or openedWithinDays`);
  }
  return problems;
}
