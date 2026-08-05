/**
 * Host-side residency: everything the platform deliberately refuses to know.
 *
 * `@starkeep/sync-engine` owns the *shape* of the residency decision — the
 * resolution order, the keep rules, the budgets, the durability predicate —
 * and knows nothing about what a size class is or which node it is running on.
 * This module supplies both, because they are host facts:
 *
 *   - **Which class a record belongs to.** A namespace and a rung: the host
 *     knows which apps are installed and which label key each one uses for its
 *     ladder, so it can read every app's rungs at once. Nothing here hard-codes
 *     a class name, so a ladder can be respecified without touching this file.
 *   - **Which node this is.** `starkeep/no-cloud` forbids the cloud and says
 *     nothing about a laptop, so only the host can turn a record constraint
 *     into "denied here".
 *   - **Pins.** Node-local, deliberately not a label: a pin shared as a label
 *     would let one device's preference silently rewrite every other device's
 *     cache policy. That is the expensive mistake available in this area.
 *
 * ## Why this lives in the sync engine rather than beside a server
 *
 * It used to live in `apps/local-data-server`, which was fine while exactly one
 * node made residency decisions. The phone makes them too, and it makes them
 * against the same rules — so the choice was between moving this or growing a
 * second copy, and a second copy of "which bytes may this node hold" is how two
 * nodes come to disagree about what they have.
 *
 * It moved unchanged: every dependency was already a package and there was not
 * one Node-specific import in it. That it was portable all along is the reason
 * the move is safe, and the reason it should have started here.
 *
 * ## How a namespace is chosen, and why an app cannot choose its own
 *
 * {@link resolveClass} below is the whole of it, and every branch answers from
 * something the writing app does not control:
 *
 * | the candidate is | namespace | rung |
 * |---|---|---|
 * | an app-syncable row | the owning app | a reserved rung |
 * | a record with no parent | the platform | `original:<category>` |
 * | a record with a parent, labelled | the **label row's** app | the label's value |
 * | a record with a parent, unlabelled | the record's origin app | a reserved rung |
 *
 * `parentId` is a column, `origin_app_id` is set from the authenticated writer,
 * and a label row's `app_id` is server-set with no way to express another app's
 * namespace. So an app can say which rung of *its own* ladder something is, and
 * nothing else. It cannot promote an original into a cheap rung, demote a
 * rendition into the protected tier, or spend a neighbour's budget.
 *
 * The last row of that table is the one worth watching: a derivative nobody
 * labelled. It is charged to whoever created the record, which is the honest
 * answer, and where even that is unknown it falls to the platform namespace and
 * is treated as an original — the fail-closed direction, since the cost of
 * wrongly calling something re-derivable is that it is deleted.
 */

import {
  evaluateOverrides,
  NO_OVERRIDES,
  type OverrideRule,
  type OverrideVerdict,
} from "./index.js";
import type { RawDatabase } from "@starkeep/storage-adapter";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  createSqliteResidentSetIndex,
  decideResidency,
  evictClass,
  evictNamespace,
  isPlatformClass,
  previewBudgetReduction,
  resolveSizeClass,
  validateRetentionPolicy,
  PLATFORM_NAMESPACE,
  type BlobCandidate,
  type DurabilityPolicy,
  type EvictionOutcome,
  type NodeRetentionPolicy,
  type ReductionPreview,
  type ReplicaProbe,
  type ResidencyVerdict,
  type ReconcileReport,
  type ResidentSetIndex,
  type ResolvedSizeClass,
} from "./index.js";
import { getCategory, typeCategory } from "@starkeep/protocol-primitives";
import type { StarkeepId } from "@starkeep/protocol-primitives";

/** Label namespace for platform-level record constraints. */
export const STARKEEP_LABEL_APP_ID = "starkeep";
/** Record label forbidding these bytes from reaching cloud storage. */
export const NO_CLOUD_LABEL_KEY = "no-cloud";

/**
 * Class prefix for records that are not a derived rendition — i.e. the thing
 * itself.
 *
 * Split by media category, because one 4K clip is worth hundreds of stills in
 * bytes and under a pooled budget one silently starves the other depending on
 * ingest order. Every other class gets the split for free from its own name.
 */
export const ORIGINAL_CLASS_PREFIX = "original";

/** The platform class for the thing itself — `starkeep:original:image`. */
export function originalClassFor(type: string | null): ResolvedSizeClass {
  return resolveSizeClass(
    PLATFORM_NAMESPACE,
    `${ORIGINAL_CLASS_PREFIX}:${type === null ? "other" : typeCategory(type)}`,
  );
}

/**
 * The rung given to an app's own bytes that carry no ladder label: its
 * app-syncable files, and any derived record it never classified.
 *
 * Reserved in the sense that the platform assigns it, not that an app is
 * prevented from naming a rung the same thing — that collision is harmless,
 * because both land in the same app's namespace and the same budget either way.
 */
export const UNCLASSIFIED_RUNG = "unclassified";

/** The shape both callers of {@link pickLadderLabel} have. */
export interface LadderLabel {
  readonly appId: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Which of a record's labels names its size class, when more than one app has
 * labelled it.
 *
 * Two apps labelling one derivative is not a corner case — it is the case
 * app-namespaced classes were introduced to support, and both places that
 * classify a record have to answer it the *same* way. The census promises "this
 * is what saying yes would cost", which it can only keep if the class it counts
 * a record under is the class the manager will charge it to.
 *
 * So the choice is a rule rather than whichever row the database happened to
 * return first:
 *
 * 1. **The record's origin app wins.** It made the record; its ladder is the one
 *    that describes what these bytes are. Another app's label is an annotation
 *    on someone else's file.
 * 2. **Otherwise the lowest app id**, and within one app the lowest value — an
 *    arbitrary rule, but a *stable* one, which is the property that matters.
 *    An unstable choice moves a record between namespaces on re-resolution, and
 *    the byte it moves is charged to two budgets and evicted by neither.
 */
export function pickLadderLabel<T extends LadderLabel>(
  labels: readonly T[],
  sizeClassKeys: Readonly<Record<string, string>>,
  originAppId: string | null,
): T | undefined {
  let best: T | undefined;
  for (const label of labels) {
    if (sizeClassKeys[label.appId] !== label.key || label.value === "") continue;
    if (best === undefined || beats(label, best, originAppId)) best = label;
  }
  return best;
}

function beats(a: LadderLabel, b: LadderLabel, originAppId: string | null): boolean {
  if (a.appId !== b.appId) {
    if (a.appId === originAppId) return true;
    if (b.appId === originAppId) return false;
    return a.appId < b.appId;
  }
  // One app, two rungs on the same key: keys are set-valued, so this is legal.
  // Either answer is as good as the other; picking the same one every time is
  // not optional.
  return a.value < b.value;
}

export interface ResidencyManagerOptions {
  readonly localDb: RawDatabase;
  readonly databaseAdapter: DatabaseAdapter;
  readonly localObjectStorage: ObjectStorageAdapter;
  /**
   * Which label key each installed app uses to name its ladder rungs, keyed by
   * app id — `{ photos: "rendition" }` on a node with Photos installed.
   *
   * A map rather than one configured `{ appId, key }` because a single entry
   * made exactly one app's ladder legible: every other app's derivatives matched
   * nothing, fell to the original class, and were then treated as irreplaceable
   * last copies of user content. A host that knows which apps are installed
   * knows all of these, so installing an app makes its ladder legible with no
   * operator step.
   *
   * An app with no entry is not an error — it declares no size-class key, so it
   * produces no rungs, and anything it does derive lands in its own namespace
   * under {@link UNCLASSIFIED_RUNG}.
   */
  readonly sizeClassKeys: Readonly<Record<string, string>>;
  /**
   * Per-record overrides expressed as rules over labels. Node-local, like pins.
   *
   * Empty by default so a node that has never configured any behaves exactly as
   * it did before rules existed.
   */
  readonly overrideRules?: readonly OverrideRule[];
  /**
   * True when this process is the node that `starkeep/no-cloud` forbids. False
   * for a laptop or phone, which may hold no-cloud records freely — that is the
   * entire point of the flag.
   */
  readonly isCloudNode: boolean;
  readonly policy: NodeRetentionPolicy;
  readonly durability: DurabilityPolicy;
}

export interface ResidencyManager {
  readonly index: ResidentSetIndex;
  /** The fetch-time decision, ready to hand to `createSyncEngine`. */
  decide(candidate: BlobCandidate): Promise<ResidencyVerdict>;
  /**
   * Record that a blob landed. Called after a successful transfer, so byte
   * accounting reflects what is actually on disk rather than what was intended.
   *
   * Takes the whole verdict rather than just its class, because the verdict is
   * the only place the *resolved* pin exists — `decide` honours the pins table
   * and any `effect: "pin"` override rule, and this used to re-read the table
   * alone. See {@link ResidencyVerdict.pinned}.
   */
  noteArrival(candidate: BlobCandidate, verdict: ResidencyVerdict | null): Promise<void>;
  /**
   * Charge a budget for bytes that are about to be fetched.
   *
   * Called between the decision and the transfer, and undone by
   * {@link releaseReservation} if the transfer does not happen. See
   * {@link ResidentSetIndex.reserve} for why the accounting has to move early in
   * this one case: the supervisor hands one index to several engines that tick
   * independently, so without it each of them sees the same room and lands into
   * it.
   */
  reserve(candidate: BlobCandidate, verdict: ResidencyVerdict): void;
  /** Undo a reservation whose transfer failed or was declined. */
  releaseReservation(objectStorageKey: string): void;
  noteDeparture(objectStorageKey: string): void;
  /**
   * Reconcile the index against what this node's object storage actually holds,
   * correcting rows the index believed and storage does not have.
   *
   * Returns keys storage holds that the index has never seen — locally imported
   * originals and derived renditions, which arrived by a route that never
   * touched `noteArrival` and are therefore invisible to every budget. Resolving
   * those needs the record row, which is the host's to join.
   */
  reconcile(): Promise<ReconcileReport>;
  /** Whether this node held these bytes and let them go. */
  wasEvicted(objectStorageKey: string): boolean;
  isPinned(recordId: string): boolean;
  setPinned(recordId: string, pinned: boolean): void;
  markOpened(recordId: string, atMs: number): void;
  classOf(candidate: BlobCandidate): Promise<ResolvedSizeClass>;
  usageByClass(): Record<string, number>;
  /** Bytes held per namespace — what each app's total is being measured against. */
  usageByNamespace(): Record<string, number>;
  runEviction(probes: readonly ReplicaProbe[]): Promise<EvictionOutcome[]>;
  previewReduction(
    sizeClass: string,
    newBudgetBytes: number,
    probes: readonly ReplicaProbe[],
  ): Promise<ReductionPreview>;
}

type DB = Record<string, Record<string, unknown>>;
const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const PINS_TABLE = "local_pins";

export function createResidencyManager(
  options: ResidencyManagerOptions,
): ResidencyManager {
  const {
    localDb,
    databaseAdapter,
    localObjectStorage,
    sizeClassKeys,
    overrideRules = [],
    isCloudNode,
    policy,
    durability,
  } = options;

  const problems = validateRetentionPolicy(policy);
  if (problems.length > 0) {
    // Refused here rather than absorbed, because every problem this catches
    // manifests as blobs quietly not arriving — which looks like a network
    // fault, not a configuration error, and is diagnosed accordingly.
    throw new Error(`Invalid retention policy:\n  ${problems.join("\n  ")}`);
  }

  const index = createSqliteResidentSetIndex({ db: localDb });

  // Pins live in their own table rather than on the resident-set row because a
  // pin is meaningful *before* the bytes arrive — pinning is how you ask for
  // something you don't have yet.
  localDb.exec(
    qb.schema
      .createTable(PINS_TABLE)
      .ifNotExists()
      .addColumn("record_id", "text", (c) => c.primaryKey())
      .addColumn("pinned_at_ms", "integer", (c) => c.notNull())
      .compile().sql,
  );
  const pinInsert = localDb.prepare(
    qb
      .insertInto(PINS_TABLE)
      .values({ record_id: sql.raw("?"), pinned_at_ms: sql.raw("?") })
      .onConflict((oc) => oc.column("record_id").doNothing())
      .compile().sql,
  );
  const pinDelete = localDb.prepare(
    qb.deleteFrom(PINS_TABLE).where("record_id", "=", sql.raw("?")).compile().sql,
  );
  const pinGet = localDb.prepare(
    qb.selectFrom(PINS_TABLE).select("record_id").where("record_id", "=", sql.raw("?")).compile().sql,
  );

  function isPinned(recordId: string): boolean {
    return pinGet.get(recordId) !== undefined;
  }

  /**
   * Both label-derived inputs come from one read.
   *
   * `getLabel` can't serve either of them: `value` is part of a label's primary
   * key (keys are set-valued), and the whole point here is that we don't know
   * the value — we're asking what it is. So this reads the record's labels once
   * and answers both questions from the same result, which also keeps the
   * per-blob cost at one query rather than two.
   */
  async function labelInputs(
    candidate: BlobCandidate,
  ): Promise<{ sizeClass: ResolvedSizeClass; deniedHere: boolean; overrides: OverrideVerdict }> {
    // App-syncable blobs carry no shared-record labels, so there is nothing to
    // read — but they are unambiguously one app's own bytes, so they belong in
    // that app's namespace and against that app's total rather than in a
    // node-wide fallback that nobody's budget describes.
    if (candidate.appId !== null) {
      return {
        sizeClass: resolveSizeClass(candidate.appId, UNCLASSIFIED_RUNG),
        deniedHere: false,
        overrides: NO_OVERRIDES,
      };
    }

    // BlobCandidate carries ids as plain strings — the sync engine normalizes
    // shared records and app-syncable rows into one shape, and only the former
    // have StarkeepIds.
    const recordId = candidate.recordId as StarkeepId;
    const byRecord = await databaseAdapter.getLabelsByRecordIds([recordId]);
    const labels = (byRecord.get(recordId) ?? []).filter((l) => !l.deletedAt);

    return {
      // Evaluated from the same label read, not a second query. Rules are the
      // scalable form of a pin — "keep every photo of my daughter" is one
      // sentence and five thousand records, and pinning ids would freeze that
      // intent at pin time so every later photo silently falls outside it.
      overrides: evaluateOverrides(overrideRules, labels),
      sizeClass: resolveClass(candidate, labels),
      // A laptop or phone may hold a no-cloud record freely — the constraint is
      // about the cloud, and reading it as "nobody may hold this" would turn a
      // privacy preference into data loss.
      deniedHere:
        isCloudNode &&
        labels.some(
          (l) => l.appId === STARKEEP_LABEL_APP_ID && l.key === NO_CLOUD_LABEL_KEY,
        ),
    };
  }

  /**
   * Namespace and rung for a shared record, from its structure and its labels.
   *
   * Total by construction — every branch returns a class — because the
   * alternative was a null that {@link decideResidency} then had to interpret,
   * and "unclassified" is a decision about someone's disk that deserves to be
   * made here, once, where the evidence is.
   */
  function resolveClass(
    candidate: BlobCandidate,
    labels: readonly { appId: string; key: string; value: string }[],
  ): ResolvedSizeClass {
    // No parent means this *is* the thing itself. Decided from the column, not
    // from the absence of a label: a record whose ladder label failed to write
    // is still a rendition, and calling it an original would charge it to the
    // protected budget and refuse to evict it.
    if (candidate.parentId === null) return originalClassFor(candidate.type);

    // A derivative. The namespace comes from whichever app's *own* declared key
    // this label was written under, and `appId` on a label row is server-set —
    // there is no way for an app to express another app's namespace here.
    // Where several apps have labelled it, the tie-break is a rule shared with
    // the census rather than the order the label read returned.
    const rung = pickLadderLabel(labels, sizeClassKeys, candidate.originAppId);
    if (rung !== undefined) return resolveSizeClass(rung.appId, rung.value);

    // Derived, but nobody labelled it — the app declares no size-class key, or
    // it failed to label this one. Charge it to whoever created the record.
    if (candidate.originAppId !== null) {
      return resolveSizeClass(candidate.originAppId, UNCLASSIFIED_RUNG);
    }

    // Derived, and we cannot say by whom. Treated as an original: it is the
    // only branch here with no evidence at all, and the two mistakes are not
    // symmetric — calling an original re-derivable gets it deleted, while
    // calling a rendition irreplaceable only costs disk.
    return originalClassFor(candidate.type);
  }

  async function classOf(candidate: BlobCandidate): Promise<ResolvedSizeClass> {
    return (await labelInputs(candidate)).sizeClass;
  }

  /**
   * The two dates the policy's recency axis reads, which only the host can
   * answer.
   *
   * ## Why this had to exist for `recent-only` to mean anything
   *
   * `decideResidency` has a whole recency branch, and both fields it reads were
   * hard-coded `null` at every construction site the sync path uses
   * (`candidateForRecord`, `candidateForManifest`, `candidateForAppRow`) — the
   * engine has only the record row, and capture time lives in the per-category
   * metadata table. Null reads as "unknown", and unknown deliberately means
   * *fetch* ("an unknown date is not evidence of age"), so the window never
   * excluded anything: `keep: "recent-only"` was `keep: "all"` capped by the
   * budget, reporting `budget-exhausted` — a different reason with a different
   * remedy — once the class filled.
   *
   * Worse than merely inert, because the projection did not share the gap.
   * `census.ts` reads a real `COALESCE(im.captured_at, vm.captured_at)` and
   * tells the operator that "keep the last 90 days" costs 12 GB, an outcome the
   * engine could not produce. The census and the manager are required to
   * classify by the same rule — `resolveClass` and `pickLadderLabel` exist as
   * shared code precisely so they cannot drift — and the recency axis was the
   * one place that requirement did not hold.
   *
   * Read here rather than pushed down into the engine because it is a host fact
   * in exactly the sense the module header describes: the platform must not
   * learn that a photograph has a capture date. Widening a query this function
   * already makes per candidate, rather than adding a new one to the hot path.
   */
  async function recencyInputs(
    candidate: BlobCandidate,
  ): Promise<{ recencyAtMs: number | null; lastOpenedAtMs: number | null }> {
    // Whatever the caller already knew wins. `MobileNode.fetchBlob` passes
    // `lastOpenedAtMs: Date.now()` because opening a photo is the event, and it
    // knows that better than any row does.
    const lastOpenedAtMs =
      candidate.lastOpenedAtMs ?? lastOpenedFromIndex(candidate.recordId);
    if (candidate.recencyAtMs !== null) {
      return { recencyAtMs: candidate.recencyAtMs, lastOpenedAtMs };
    }
    return { recencyAtMs: await capturedAtMs(candidate), lastOpenedAtMs };
  }

  /** The most recent open across every blob this node holds for the record. */
  function lastOpenedFromIndex(recordId: string): number | null {
    let latest: number | null = null;
    for (const entry of index.entriesOfRecord(recordId)) {
      if (entry.lastOpenedAtMs === null) continue;
      if (latest === null || entry.lastOpenedAtMs > latest) latest = entry.lastOpenedAtMs;
    }
    return latest;
  }

  /**
   * Capture time in epoch ms from the record's per-category metadata, or null.
   *
   * Null on every uncertainty — an app-syncable row (no shared-record metadata
   * exists for one), a category with no `captured_at` column, a missing row, an
   * unparseable value, a table that would not read. That is the fail-open
   * direction *for data*: unknown makes `recent-only` fetch, and the census
   * agrees ("an unknown date must not read as 'ancient', or every undated
   * record falls outside every recency window and is quietly marked for
   * eviction"). Missing metadata must not become deleted bytes.
   *
   * Deliberately **not** falling back to the record's `createdAt`. That column
   * holds a serialized HLC, not a date, and reading it as a timestamp yields a
   * number that is meaningless and — worse — plausible.
   */
  async function capturedAtMs(candidate: BlobCandidate): Promise<number | null> {
    if (candidate.appId !== null || candidate.type === null) return null;
    // Asked of the type system rather than hard-coded to image and video: which
    // categories carry a capture date is the core type table's business, and a
    // category gaining one should start working here without an edit.
    const category = getCategory(typeCategory(candidate.type));
    if (!category?.metadataColumns.some((c) => c.name === CAPTURED_AT_COLUMN)) {
      return null;
    }
    try {
      const recordId = candidate.recordId as StarkeepId;
      const rows = await databaseAdapter.getMetadataByIds(candidate.type, [recordId]);
      return parseCapturedAt(rows.get(recordId)?.[CAPTURED_AT_COLUMN]);
    } catch (err) {
      console.warn(
        `[residency] could not read capture time for ${candidate.recordId}; treating it as unknown: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Whether these bytes may only be dropped once a replica is confirmed.
   *
   * The question is "can this be made again?", and only one fact answers it:
   * a derivative can be re-derived from its parent, and nothing else can. So
   * the test is `parentId`, with the namespace as a second gate for the case
   * where the parent is present but we could not say whose derivative it is —
   * `resolveClass` sends that to the platform namespace deliberately, and this
   * has to agree or the fail-closed branch is fail-open two lines later.
   *
   * An app-syncable blob is the case that makes the namespace alone wrong. It
   * is one app's own bytes, so it belongs in that app's namespace and against
   * that app's total — but it is not derived from anything, and this node may
   * hold the only copy. Reading proof off the namespace would have made every
   * app's own files freely deletable.
   *
   * ## What it means that only arrivals reach this
   *
   * Answered on `reserve` and `noteArrival` — the inbound paths — so the
   * question is asked only about bytes the index knows about. Bytes it does not
   * know about are not *unprotected*, they are **invisible**: the eviction pass
   * draws its candidates from this table, so a blob with no row is never offered
   * for deletion at all. The direction of that gap is the safe one — it costs
   * disk, not data — and `reconcile` is what surfaces those keys so a host can
   * charge them to a budget deliberately rather than have them quietly not
   * count.
   */
  function requiresProof(candidate: BlobCandidate, cls: ResolvedSizeClass): boolean {
    if (candidate.appId !== null) return true;
    return candidate.parentId === null || isPlatformClass(cls);
  }

  async function decide(candidate: BlobCandidate): Promise<ResidencyVerdict> {
    const { sizeClass, deniedHere, overrides } = await labelInputs(candidate);
    // The recency axis reads two dates the engine cannot know. Without this the
    // `recent-only` branch of `decideResidency` could never decline anything —
    // see {@link recencyInputs}.
    const enriched: BlobCandidate = { ...candidate, ...(await recencyInputs(candidate)) };
    return decideResidency({
      candidate: enriched,
      sizeClass,
      policy,
      // An `exclude` rule is a *constraint*, not a negative pin. Routing it
      // here rather than through `overrides` is what makes it beat a pin —
      // decideResidency checks constraints first, in the fixed §6.1 order, and
      // restrictive winning is exactly the intent.
      constraints: { deniedHere: deniedHere || overrides.excluded },
      overrides: { pinned: isPinned(candidate.recordId) || overrides.pinned },
      usage: (cls) => (cls === null ? 0 : index.usageOf(cls.qualified)),
      namespaceUsage: (namespace) => index.usageOfNamespace(namespace),
    });
  }

  return {
    index,
    decide,
    classOf,
    isPinned,

    async noteArrival(
      candidate: BlobCandidate,
      verdict: ResidencyVerdict | null,
    ): Promise<void> {
      // A null class means the caller had no residency decision to hand over —
      // the conservative reading is the thing itself, which is what an
      // unclassified arrival has always been charged as.
      const cls = verdict?.sizeClass ?? originalClassFor(candidate.type);
      // Resolved again rather than carried from the decision, because there is
      // no decision on every path here — `fetchBlob` lands bytes without one.
      // The row's `recency_at_ms` is the eviction pass's third ordering term, so
      // a null here is not cosmetic: it collapses "oldest first" into whatever
      // order the index happens to return.
      const dates = await recencyInputs(candidate);
      index.add({
        recordId: candidate.recordId,
        objectStorageKey: candidate.objectStorageKey,
        sizeBytes: candidate.sizeBytes,
        sizeClass: cls.qualified,
        namespace: cls.namespace,
        // The pin the *decision* resolved, which is the only one that saw both
        // sources. Falling back to the table alone — as this used to do
        // unconditionally — dropped every rule-derived pin on the floor, so a
        // record a rule had just made this node fetch past its budget landed
        // with `pinned = 0` and was evictable by the very pass the rule existed
        // to survive. The fallback remains for `fetchBlob`, which synthesizes a
        // verdict it never asked the policy for.
        pinned: verdict?.pinned ?? isPinned(candidate.recordId),
        // Set by the derivation work (item 7), which is what knows whether
        // these bytes are still needed as an input here. Until then nothing is
        // marked protected, and the durability predicate is what stands
        // between the eviction pass and a last copy.
        //
        // That used to be a load-bearing dependency between two unfinished
        // things: `protectedLocally` waits on item 7, *and* the pass skipped the
        // durability check for renditions on the grounds that item 7 could remake
        // them. Both halves assumed a capability nobody had.
        // `EvictionRequest.canRederive` now defaults false, so the missing
        // derivation makes the pass more careful rather than silently less, and
        // this field can stay honest about being unimplemented.
        protectedLocally: false,
        // A rendition can be re-derived; nothing else here can. Decided from
        // the record's structure rather than by testing the class name for an
        // `original:` prefix, as this once did — the prefix test was a naming
        // convention standing in for a structural fact, and the failure mode of
        // a class rename breaking it is that originals silently become
        // evictable.
        requiresDurabilityProof: requiresProof(candidate, cls),
        recencyAtMs: dates.recencyAtMs,
        lastOpenedAtMs: dates.lastOpenedAtMs,
        addedAtMs: Date.now(),
      });
    },

    reserve(candidate: BlobCandidate, verdict: ResidencyVerdict): void {
      const cls = verdict.sizeClass ?? originalClassFor(candidate.type);
      index.reserve({
        recordId: candidate.recordId,
        objectStorageKey: candidate.objectStorageKey,
        sizeBytes: candidate.sizeBytes,
        sizeClass: cls.qualified,
        namespace: cls.namespace,
        pinned: verdict.pinned ?? isPinned(candidate.recordId),
        protectedLocally: false,
        requiresDurabilityProof: requiresProof(candidate, cls),
        // Deliberately not resolved here. A reservation exists for a few seconds
        // and is replaced by `noteArrival`, which reads them properly; spending
        // a metadata query per in-flight blob to populate a row that is about to
        // be overwritten would put a read on the hot path for nothing.
        recencyAtMs: null,
        lastOpenedAtMs: null,
        addedAtMs: Date.now(),
      });
    },

    releaseReservation(objectStorageKey: string): void {
      index.release(objectStorageKey);
    },

    reconcile(): Promise<ReconcileReport> {
      return index.reconcile(localObjectStorage);
    },

    wasEvicted(objectStorageKey: string): boolean {
      return index.wasEvicted(objectStorageKey);
    },

    noteDeparture(objectStorageKey: string): void {
      // Departed, not forgotten — same reason as the eviction pass. "This node
      // let these bytes go" and "this node never had them" are different facts,
      // and only the first one tells `residencyOf` that no sync round will bring
      // them back.
      index.markDeparted(objectStorageKey);
    },

    setPinned(recordId: string, pinned: boolean): void {
      if (pinned) pinInsert.run(recordId, Date.now());
      else pinDelete.run(recordId);
      // Mirror onto every held blob of this record so the eviction pass sees
      // the pin without a join. The pins table is the durable answer (it
      // outlives eviction and covers records whose bytes aren't here yet); the
      // index rows are the pass's working set. A record's original and each of
      // its renditions are separate rows, and a pin means all of them.
      for (const entry of index.entriesOfRecord(recordId)) {
        index.setPinned(entry.objectStorageKey, pinned);
      }
    },

    markOpened(recordId: string, atMs: number): void {
      for (const entry of index.entriesOfRecord(recordId)) {
        index.markOpened(entry.objectStorageKey, atMs);
      }
    },

    usageByClass(): Record<string, number> {
      return index.usageByClass();
    },

    usageByNamespace(): Record<string, number> {
      return index.usageByNamespace();
    },

    async runEviction(probes: readonly ReplicaProbe[]): Promise<EvictionOutcome[]> {
      const outcomes: EvictionOutcome[] = [];
      const shared = {
        index,
        policy,
        localStorage: localObjectStorage,
        probes,
        durability,
        contentHashOf: (entry: { objectStorageKey: string }) =>
          contentHashOfKey(entry.objectStorageKey),
      };

      // Per class first, so a full video budget evicts video and does not touch
      // stills. Classes with no held bytes are skipped rather than evaluated.
      for (const sizeClass of Object.keys(index.usageByClass())) {
        outcomes.push(await evictClass({ ...shared, sizeClass }));
      }

      // Then per namespace, because an app can be inside every one of its rows
      // and still over its total — the per-class passes above would each find
      // nothing to do and leave the breach standing. Runs second so it works
      // against what the class passes have already freed rather than
      // double-counting bytes that are about to go anyway.
      for (const namespace of Object.keys(index.usageByNamespace())) {
        if (namespace === PLATFORM_NAMESPACE) continue;
        outcomes.push(await evictNamespace({ ...shared, namespace }));
      }
      return outcomes;
    },

    previewReduction(
      sizeClass: string,
      newBudgetBytes: number,
      probes: readonly ReplicaProbe[],
    ): Promise<ReductionPreview> {
      return previewBudgetReduction({
        sizeClass,
        newBudgetBytes,
        index,
        probes,
        durability,
        contentHashOf: (entry) => contentHashOfKey(entry.objectStorageKey),
      });
    },
  };
}

/**
 * Adapt a manager into the hooks the sync engine takes.
 *
 * Separate from the manager so the engine's surface stays two functions —
 * decide, and account for what landed — rather than the whole management API.
 */
export function residencyHooks(manager: ResidencyManager): {
  decide(candidate: BlobCandidate): Promise<ResidencyVerdict>;
  onLanded(candidate: BlobCandidate, verdict: ResidencyVerdict): Promise<void>;
  reserve(candidate: BlobCandidate, verdict: ResidencyVerdict): void;
  release(objectStorageKey: string): void;
  classOf(candidate: BlobCandidate): Promise<ResolvedSizeClass>;
} {
  return {
    decide: (candidate) => manager.decide(candidate),
    onLanded: (candidate, verdict) => manager.noteArrival(candidate, verdict),
    // The pair that makes one budget bind across several engines sharing this
    // manager, rather than each of them landing into the same apparent room.
    reserve: (candidate, verdict) => manager.reserve(candidate, verdict),
    release: (objectStorageKey) => manager.releaseReservation(objectStorageKey),
    // Class without decision, for the on-demand fetch: it must charge the right
    // budget without asking a policy that is not entitled to refuse it.
    classOf: (candidate) => manager.classOf(candidate),
  };
}

/** The per-category metadata column holding a record's own date. */
const CAPTURED_AT_COLUMN = "captured_at";

/**
 * A stored `captured_at` as epoch ms, or null for anything unusable.
 *
 * The column is a SQL `timestamp`, which SQLite hands back as a string with no
 * zone. `Date.parse` reads a bare `2024-01-01T10:00:00` as *local* time while
 * the census's `strftime('%s', ...)` reads the same string as UTC, so the two
 * would disagree by the operator's offset — up to fourteen hours, which is
 * enough to move a record across a day boundary at the edge of a recency
 * window. A zone is appended when none is present so both read it the same way.
 */
function parseCapturedAt(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim().replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The content hash a shared key names. Read off the key rather than the record
 * row: the durability check runs against keys this node holds, and a key that
 * isn't in the canonical content-addressed shape has no hash to verify a
 * replica against — so it returns null and the eviction pass refuses.
 */
function contentHashOfKey(objectStorageKey: string): string | null {
  const segments = objectStorageKey.split("/");
  if (segments.length !== 4 || segments[0] !== "shared") return null;
  const hash = segments[3]!;
  if (!/^[a-f0-9]{64}$/.test(hash) || segments[2] !== hash.slice(0, 2)) return null;
  return hash;
}
