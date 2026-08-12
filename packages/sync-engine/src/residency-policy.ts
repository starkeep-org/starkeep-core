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
 * ## This module used to predict what the eviction pass would do
 *
 * It had four keep rules, a capture-date window and an opened-within window,
 * and every one of them was an operator-authored *guess* at the answer the
 * eviction pass computes from real data. That is the wrong division of labour,
 * and it produced exactly the failure you would expect from it: `recent-only`
 * read `captured_at` off the record, renditions have no `captured_at`, so on
 * every rung of every ladder the rule silently behaved as "keep everything,
 * capped by budget" — for months, with the census agreeing, because the census
 * computed recency the same way.
 *
 * A cache needs an **eviction policy**, not an admission policy. What survives
 * of admission is the one thing eviction cannot express: whether to *acquire*
 * these bytes speculatively at all. So a row is now two fields:
 *
 *   - {@link SizeClassRetention.prefetch} — pull this class during a sync
 *     round, or only when something actually asks for it.
 *   - {@link SizeClassRetention.share} — how much of the namespace's budget
 *     this class may occupy, relative to its siblings. Zero means none.
 *
 * Everything else — which bytes go first, which stay, what "recently useful"
 * means — is {@link compareEvictionRank}, applied to what the node is actually
 * holding, at the moment the budget actually binds.
 *
 * ## One budget per namespace, divided by share
 *
 * There used to be two independent budget levels: an absolute byte count on
 * every row, *plus* a namespace total checked separately. They failed
 * independently, which is why there was a second eviction pass over whole
 * namespaces — and they drifted, because nothing made them agree. The one
 * shipped policy had photos rows summing to ~14.24 GB against a stated total of
 * 14 GB.
 *
 * Now a namespace has one byte count and rows carry *shares* of it. The row
 * budgets sum to the total by construction, so a node inside every row is
 * inside its total, and the namespace pass has nothing left to do. The operator
 * sets the number they actually care about — "Photos may use 20 GB" — and the
 * shares say how it is divided.
 *
 * Per-class division still earns its place: value density across a ladder
 * varies by three orders of magnitude, and a single pooled cache would let
 * three originals evict an entire thumbnail set.
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
 * to escape into a fallback row — is bounded by {@link FALLBACK_RUNG}: every
 * unrecognised rung of a namespace shares *one* budget line, so inventing a
 * thousand of them buys one budget rather than a thousand.
 */

/** One row of the §6.2 retention table. */
export interface SizeClassRetention {
  /**
   * Pull this class as part of an ordinary sync round.
   *
   * False is the `on-demand-only` case and it is the whole of what survives of
   * the old keep-rule enum, because it is the only part of it that a cache's
   * eviction order cannot express. `image-large` exists so somebody can zoom
   * into one photograph; fetching every one of them speculatively would spend
   * the budget on bytes nobody looked at, and no eviction ordering can undo
   * that because the download has already happened.
   *
   * False does **not** mean "never hold this". An explicit request — someone
   * opening the item — still lands the bytes and still charges them to this
   * row's share. That is what makes the class a cache of the working set rather
   * than a permanent round trip to the cloud. Use `share: 0` to hold none.
   */
  readonly prefetch: boolean;
  /**
   * This class's claim on its namespace's budget, relative to its siblings.
   *
   * Not bytes. Shares are resolved against
   * {@link NamespaceRetention.budgetBytes} at the moment a decision is made
   * ({@link budgetBytesFor}), which is what makes the rows unable to disagree
   * with the total — the thing two independent absolute budgets could not
   * promise, and did not deliver.
   *
   * The unit is arbitrary and only ratios matter: `{ a: 1, b: 3 }` and
   * `{ a: 25, b: 75 }` are the same policy. Percentages are the natural way to
   * write one and nothing depends on them summing to a hundred.
   *
   * **Zero is how a node says it wants none of a class.** That reading is
   * unambiguous here in a way it could not be under the old model, where a zero
   * budget sat beside a `keep` rule that contradicted it and a whole
   * normalization step existed to break the tie.
   */
  readonly share: number;
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
 * The rung standing for "every unrecognised rung of this namespace, together".
 *
 * Not a real rung and deliberately not a legal one — a rung comes from a label
 * value, and `*` is reserved here so a budget line key can never collide with a
 * class name.
 *
 * Pooling is what closes the rung-invention hole structurally. Under absolute
 * per-row budgets, an app naming a thousand rungs got a thousand fallback
 * budgets, and a separate namespace-wide total had to be introduced to bound
 * it. One shared line needs no such backstop: a thousand invented rungs spend
 * one share between them.
 */
export const FALLBACK_RUNG = "*";

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

/**
 * One namespace: its rungs, how the budget divides between them, and how many
 * bytes there are to divide.
 *
 * The platform namespace uses this shape too. It used to be the exception —
 * rows with absolute budgets and no total — and the exception bought nothing
 * except a `number | null` that every consumer had to branch on. An operator
 * asking "how much disk may originals take" deserves one field to set, the same
 * as they get for an app.
 */
export interface NamespaceRetention {
  /** Rungs this namespace declares, keyed by the label value. */
  readonly rows: Readonly<Record<string, SizeClassRetention>>;
  /**
   * The share given to {@link FALLBACK_RUNG} — every rung with no row of its
   * own, pooled into one budget line.
   */
  readonly fallback: SizeClassRetention;
  /** Every byte this namespace may hold, across all of its rungs. */
  readonly budgetBytes: number;
}

/**
 * A node's whole retention policy: platform classes, then one namespace per app.
 *
 * Two levels rather than one flat table because the requirement is a budget
 * *per app* and a division within the app, and a flat table can only express
 * the second. It also puts the one boundary that matters — platform versus app
 * — in the structure rather than in a naming convention.
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
  readonly platform: NamespaceRetention;
  /** Per-app namespaces, keyed by appId. */
  readonly apps: Readonly<Record<string, NamespaceRetention>>;
  /**
   * Applied to an app with no entry above — one the operator has never
   * configured, which is the ordinary state right after installing something.
   */
  readonly appFallback: NamespaceRetention;
}

/**
 * A budget: one namespace's share-line, and the key everything else groups by.
 *
 * This is the unit the resident set indexes, the eviction pass runs over, and
 * usage is summed against. It is *not* the size class — several size classes
 * can map to one line, which is exactly what {@link FALLBACK_RUNG} does — and
 * conflating the two is what made rung invention free.
 */
export interface BudgetLine {
  readonly namespace: string;
  /** A declared rung, or {@link FALLBACK_RUNG} for the pooled remainder. */
  readonly rung: string;
  /** `<namespace>:<rung>` — the stored grouping key. */
  readonly key: string;
}

export function namespaceRetentionFor(
  policy: NodeRetentionPolicy,
  namespace: string,
): NamespaceRetention {
  if (namespace === PLATFORM_NAMESPACE) return policy.platform;
  return policy.apps[namespace] ?? policy.appFallback;
}

/**
 * Which budget line a class spends from.
 *
 * A class the policy names spends from its own line. Everything else — an
 * unrecognised rung, a ladder respecified on another node, a class name from
 * before namespacing — spends from its namespace's pooled fallback line.
 *
 * A class that will not parse has no namespace to belong to, and guessing one
 * would charge somebody's budget for it. It goes to the platform's fallback,
 * which is where an unresolvable class has always gone and is the conservative
 * choice: the platform namespace is the protected tier.
 */
export function budgetLineFor(
  policy: NodeRetentionPolicy,
  sizeClass: ResolvedSizeClass | null,
): BudgetLine {
  if (sizeClass === null) return line(PLATFORM_NAMESPACE, FALLBACK_RUNG);
  const namespace = namespaceRetentionFor(policy, sizeClass.namespace);
  return namespace.rows[sizeClass.rung] !== undefined
    ? line(sizeClass.namespace, sizeClass.rung)
    : line(sizeClass.namespace, FALLBACK_RUNG);
}

function line(namespace: string, rung: string): BudgetLine {
  return { namespace, rung, key: `${namespace}:${rung}` };
}

/** Whether the policy names this exact class, as opposed to pooling it. */
export function hasRowFor(policy: NodeRetentionPolicy, sizeClass: ResolvedSizeClass | null): boolean {
  if (sizeClass === null) return false;
  return namespaceRetentionFor(policy, sizeClass.namespace).rows[sizeClass.rung] !== undefined;
}

/** The row governing one budget line. */
export function retentionRowFor(
  policy: NodeRetentionPolicy,
  budgetLine: BudgetLine,
): SizeClassRetention {
  const namespace = namespaceRetentionFor(policy, budgetLine.namespace);
  return budgetLine.rung === FALLBACK_RUNG
    ? namespace.fallback
    : namespace.rows[budgetLine.rung] ?? namespace.fallback;
}

/**
 * The bytes a budget line may hold: its share of its namespace's budget.
 *
 * The denominator is every declared row **plus** the fallback, so the lines of
 * a namespace sum to exactly its `budgetBytes`. That identity is the whole
 * point of the change — it is what makes a second, namespace-wide eviction pass
 * unnecessary rather than merely unlikely to fire.
 *
 * A namespace whose shares are all zero holds nothing, which is coherent and is
 * how "this app gets no disk on this node" is written. It is also the one case
 * where the denominator is zero, so it is answered before the division rather
 * than by it.
 */
export function budgetBytesFor(policy: NodeRetentionPolicy, budgetLine: BudgetLine): number {
  const namespace = namespaceRetentionFor(policy, budgetLine.namespace);
  const row = retentionRowFor(policy, budgetLine);
  const total = totalShares(namespace);
  if (total <= 0 || row.share <= 0) return 0;
  return Math.floor((namespace.budgetBytes * row.share) / total);
}

function totalShares(namespace: NamespaceRetention): number {
  let total = shareOf(namespace.fallback);
  for (const row of Object.values(namespace.rows)) total += shareOf(row);
  return total;
}

function shareOf(row: SizeClassRetention | undefined): number {
  const share = row?.share;
  return typeof share === "number" && Number.isFinite(share) && share > 0 ? share : 0;
}

/**
 * Every budget line a policy defines, so a host can enumerate them without
 * knowing the shape of the table.
 *
 * Includes each namespace's fallback line whether or not anything is currently
 * pooled into it: a line with a share is a line the eviction pass may have to
 * run over the moment an unrecognised rung arrives.
 */
export function budgetLinesOf(policy: NodeRetentionPolicy): BudgetLine[] {
  const out: BudgetLine[] = [];
  const namespaces: Array<[string, NamespaceRetention]> = [
    [PLATFORM_NAMESPACE, policy.platform],
    ...Object.entries(policy.apps),
  ];
  for (const [namespace, retention] of namespaces) {
    for (const rung of Object.keys(retention.rows)) out.push(line(namespace, rung));
    out.push(line(namespace, FALLBACK_RUNG));
  }
  return out;
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
   * They still count against the line's budget, so the overage is visible
   * rather than swallowed.
   */
  readonly pinned: boolean;
}

/**
 * Where a blob sits in the order things are given up in.
 *
 * The single ordering this system has an opinion about, extracted so the two
 * places that need it cannot drift: the resident set's `ORDER BY`, which picks
 * what an eviction pass deletes, and {@link decideResidency}, which admits a
 * new blob if it would outrank something already held.
 *
 * ## Why use beats age
 *
 * Never-opened material goes before anything anyone has looked at, then
 * least-recently-opened, and only then the record's own date. Ordering by date
 * alone reads as the obvious rule and thrashes on the behaviour people actually
 * have: browse a 2005 album and each photograph lands, is immediately displaced
 * by the next, and is fetched again the next time — egress paid twice per photo,
 * forever. What a person opened is the best available evidence about what this
 * device should keep, and it is evidence rather than a guess.
 */
export interface EvictionRank {
  /** Epoch ms this blob was last read on this node, or null if never. */
  readonly lastOpenedAtMs: number | null;
  /** The record's own date — capture time where known. Null if unknown. */
  readonly recencyAtMs: number | null;
}

/**
 * Negative when `a` should be given up before `b`.
 *
 * Mirrors `ORDER BY last_opened_at_ms IS NULL DESC, last_opened_at_ms ASC,
 * recency_at_ms ASC` exactly, **including SQLite's placement of NULL first in
 * an ascending sort** — so an undated record ranks below a dated one of any
 * age. That is the shipped ordering and it is left as it is on purpose: the
 * thing standing between this pass and a last copy is the durability
 * predicate, not the sort, and changing a comparison to do a safety job the
 * comparison cannot actually do would move the guarantee somewhere harder to
 * see.
 */
export function compareEvictionRank(a: EvictionRank, b: EvictionRank): number {
  const aNever = a.lastOpenedAtMs === null;
  const bNever = b.lastOpenedAtMs === null;
  if (aNever !== bNever) return aNever ? -1 : 1;
  if (!aNever && !bNever && a.lastOpenedAtMs !== b.lastOpenedAtMs) {
    return a.lastOpenedAtMs! - b.lastOpenedAtMs!;
  }
  const aRecency = a.recencyAtMs;
  const bRecency = b.recencyAtMs;
  if (aRecency === bRecency) return 0;
  if (aRecency === null) return -1;
  if (bRecency === null) return 1;
  return aRecency - bRecency;
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
   * The record's own date in epoch ms — capture time where the host knows it.
   * Null when unknown.
   *
   * An ordering term, not a filter. Nothing declines a blob for being old; this
   * decides where it sits in the queue if the line is full.
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
  /**
   * The budget line those bytes are charged to.
   *
   * Optional for the same reason {@link ResidencyVerdict.pinned} is:
   * `SyncEngine.fetchBlob` synthesizes a verdict it never asked the policy for,
   * and has only a class. Absent means "nobody resolved this", and the host
   * resolves the class against its own policy when it accounts for the arrival.
   */
  readonly budgetLine?: BudgetLine;
  /**
   * Whether this node insists on holding these bytes — the **resolved** pin,
   * covering both of its sources.
   *
   * A pin comes from the `local_pins` table or from an `effect: "pin"` override
   * rule matching the record's labels, and only the decision path saw both.
   * `noteArrival` re-read the table alone, so a record kept by a rule — "keep
   * every photo of my daughter offline", the motivating example the rules exist
   * for — was fetched past its budget and then written into the resident set
   * with `pinned = 0`. From there the eviction pass offered it, its
   * belt-and-braces re-check read the same column and agreed, and the census
   * reported zero pinned bytes for it: the rule that made the node fetch the
   * photo was invisible to everything that might delete it.
   *
   * Carried on the verdict rather than recomputed on arrival because the labels
   * have already been read by then, and a second evaluation is a second chance
   * to disagree.
   *
   * Optional because `SyncEngine.fetchBlob` synthesizes a verdict it never
   * asked the policy for; absent there means "nobody resolved this", and the
   * accounting falls back to the pins table.
   */
  readonly pinned?: boolean;
  readonly reason:
    | "record-constraint"
    | "pinned"
    // The line's share is zero — this node holds none of this class.
    | "class-disabled"
    // The class is not prefetched. Not a refusal: an explicit request still
    // lands the bytes, and that is what `prefetch: false` means.
    | "not-prefetched"
    | "within-budget"
    // The line was full, but this blob outranks enough already-held bytes that
    // the next eviction pass would keep it and drop them. Admitting it is how
    // a budget ends up holding the *best* of a class rather than whatever
    // happened to arrive first — see the module note on acquisition order.
    | "displaces-worse"
    // Full, and this blob is the thing that would be given up first. Declining
    // it is not a preference; fetching it would be a download followed
    // immediately by a delete.
    | "budget-exhausted"
    | "unclassified"
    // Not a decision this module made. `SyncEngine.fetchBlob` answers a direct
    // request and is deliberately not subject to the policy, but the arrival
    // still has to be charged to a budget — so it reports a verdict it did not
    // ask for, named so the residency inspector does not read it as one.
    | "explicit-request";
}

/** How many bytes this node currently holds against a budget line. */
export type LineUsageLookup = (budgetLine: BudgetLine) => number;

/**
 * Whether a line holds at least `bytesNeeded` of blobs ranked *worse* than
 * `rank` — bytes the next eviction pass would give up before it touched this
 * candidate.
 *
 * Supplied by the host because it is a question about the resident set, and
 * this module is not allowed to know what one is. It is deliberately a
 * yes/no: the policy asks whether room can be made, and the pass that actually
 * makes it is the one with the durability evidence.
 */
export type DisplacementLookup = (
  budgetLine: BudgetLine,
  rank: EvictionRank,
  bytesNeeded: number,
) => boolean;

export interface DecideResidencyInputs {
  readonly candidate: BlobCandidate;
  readonly sizeClass: ResolvedSizeClass | null;
  readonly policy: NodeRetentionPolicy;
  readonly constraints: RecordConstraints;
  readonly overrides: LocalOverrides;
  readonly usage: LineUsageLookup;
  readonly displaces: DisplacementLookup;
  /**
   * True when something actually asked for these bytes, rather than a sync
   * round offering them.
   *
   * The one input that distinguishes the two triggers, and the reason
   * admission and read-through are the same rule rather than two: a request
   * ignores {@link SizeClassRetention.prefetch} — that field is about
   * speculation, and this is not speculation — and is otherwise judged exactly
   * as an arrival is, including being declined when it would be the first thing
   * evicted. Declining there is not stinginess; landing a blob that the next
   * pass deletes is a download and a delete, and the read is served remotely
   * either way.
   */
  readonly requested?: boolean;
}

/**
 * The decision, in the fixed order of §6.1. The order matters because two of
 * the inputs pull in opposite directions: a record constraint says "nobody may
 * hold this here" and a pin says "this node insists on holding it".
 * Restrictive wins, and it wins first.
 */
export function decideResidency(inputs: DecideResidencyInputs): ResidencyVerdict {
  const { candidate, sizeClass, policy, constraints, overrides, usage, displaces } = inputs;
  const budgetLine = budgetLineFor(policy, sizeClass);
  const base = { sizeClass, budgetLine, pinned: overrides.pinned } as const;

  // 1. Record constraints — carried on the record, honoured identically
  //    everywhere. Nothing below may override.
  if (constraints.deniedHere) {
    return { ...base, decision: "elide", reason: "record-constraint" };
  }

  // 2. Local pin. Beats every budget rule, and deliberately does not beat
  //    step 1.
  if (overrides.pinned) {
    return { ...base, decision: "fetch", reason: "pinned" };
  }

  // 3. The node's rule for this record's line.
  const row = retentionRowFor(policy, budgetLine);
  const budgetBytes = budgetBytesFor(policy, budgetLine);
  if (budgetBytes <= 0) {
    return { ...base, decision: "elide", reason: "class-disabled" };
  }
  if (!row.prefetch && inputs.requested !== true) {
    // Not a failure and not a permanent refusal — an explicit fetch (a user
    // opening the item) reaches the budget check below. It just never happens
    // as part of a sync round.
    return { ...base, decision: "elide", reason: "not-prefetched" };
  }

  // 4. The budget. Checked last so that a class the node has decided to keep is
  //    only declined for want of room, never for want of interest.
  if (usage(budgetLine) + candidate.sizeBytes <= budgetBytes) {
    return {
      ...base,
      decision: "fetch",
      reason: hasRowFor(policy, sizeClass) ? "within-budget" : "unclassified",
    };
  }

  // Full — but "full" is a statement about *these particular* bytes, not about
  // the class. A sync round walks the change log forward, which is oldest
  // first, so a budget that simply stopped at full would fill a phone with 2005
  // and decline everything since. Admitting anything that outranks enough of
  // what is already held is what makes the line converge on the best of the
  // class regardless of the order things arrived in, and it is the same rule
  // that decides whether a read-miss lands.
  const needed = usage(budgetLine) + candidate.sizeBytes - budgetBytes;
  const rank: EvictionRank = {
    lastOpenedAtMs: candidate.lastOpenedAtMs,
    recencyAtMs: candidate.recencyAtMs,
  };
  if (displaces(budgetLine, rank, needed)) {
    return { ...base, decision: "fetch", reason: "displaces-worse" };
  }
  return { ...base, decision: "elide", reason: "budget-exhausted" };
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

  problems.push(...validateNamespace(PLATFORM_NAMESPACE, policy.platform));

  for (const [appId, app] of Object.entries(policy.apps)) {
    problems.push(...validateNamespace(appId, app));
    // An app id that collides with the platform namespace would write rows
    // nothing can ever read: the resolution above sends every platform class to
    // `policy.platform`, so this whole entry would sit there being ignored.
    if (appId === PLATFORM_NAMESPACE) {
      problems.push(
        `apps.${appId}: "${PLATFORM_NAMESPACE}" is the platform namespace — its rows belong in platform.rows, and here they are unreachable`,
      );
    }
  }
  problems.push(...validateNamespace("(unconfigured apps)", policy.appFallback));

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

function validateNamespace(namespace: string, retention: NamespaceRetention): string[] {
  if (!isObject(retention) || !isObject(retention.rows)) {
    return [`${namespace}: missing or malformed rows`];
  }

  const problems: string[] = [];
  for (const [rung, row] of Object.entries(retention.rows)) {
    problems.push(...validateRow(`${namespace}:${rung}`, row));
    if (rung === FALLBACK_RUNG) {
      problems.push(
        `${namespace}:${FALLBACK_RUNG}: "${FALLBACK_RUNG}" is reserved for the pooled fallback line — a rung cannot be named it`,
      );
    }
  }
  problems.push(...validateRow(`${namespace} (fallback)`, retention.fallback));

  // Zero is refused for the same reason it is refused on a row's share: a zero
  // namespace budget is a prohibition on every rung, including ones whose
  // shares say they matter, and it says so in the one place an operator reading
  // the rows will not look. A namespace that should hold nothing says so with
  // its shares.
  //
  // A *missing* budget is refused for a sharper reason — see
  // {@link isUsableBudget}. It is also now the only byte count in the
  // namespace, so an entry without one has no budget at all rather than merely
  // an unbounded one.
  if (!isUsableBudget(retention.budgetBytes)) {
    problems.push(
      `${namespace}: budgetBytes must be > 0 and finite (got ${String(retention.budgetBytes)}) — it is the only byte count in the namespace, and every row's share is resolved against it`,
    );
  }

  // Shares are ratios, so a namespace where every one of them is zero divides
  // its budget into nothing and holds nothing — an expensive way to write what
  // `budgetBytes` on its own cannot say, and almost always a table somebody
  // half-filled in.
  const anyShare =
    shareOf(retention.fallback) > 0 ||
    Object.values(retention.rows).some((row) => shareOf(row) > 0);
  if (!anyShare) {
    problems.push(
      `${namespace}: every share is zero, so none of ${String(retention.budgetBytes)} bytes can be used — give at least one row a share`,
    );
  }
  return problems;
}

function validateRow(name: string, row: SizeClassRetention | null | undefined): string[] {
  // The last place a missing object can still throw. The structural guard above
  // covers the sections, but not the `fallback` inside each of them, and not a
  // null sitting in `rows` — so `{ platform: { rows: {} } }` used to reach here
  // and read `.keep` off `undefined`, turning a 422 with a sentence into a 500
  // with a stack trace. Checked per row rather than adding three more entries to
  // the guard, because this is the one function every one of them passes
  // through, and it can then say *which* row is missing.
  if (typeof row !== "object" || row === null) return [`${name}: missing or not an object`];

  const problems: string[] = [];

  if (typeof row.prefetch !== "boolean") {
    problems.push(
      `${name}: prefetch must be true or false (got ${JSON.stringify(row.prefetch)})`,
    );
  }
  // Negative and non-finite shares are refused rather than clamped. A share is
  // a ratio and every comparison a NaN takes part in is false, so a clamped one
  // would silently become "no claim on the budget" — which is a real policy
  // (`share: 0`) that the operator did not write.
  if (typeof row.share !== "number" || !Number.isFinite(row.share) || row.share < 0) {
    problems.push(
      `${name}: share must be a finite number >= 0 (got ${String(row.share)}) — use 0 to hold none of this class`,
    );
  }
  return problems;
}
