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
  type ResidentSetIndex,
  type ResolvedSizeClass,
} from "./index.js";
import { typeCategory } from "@starkeep/protocol-primitives";
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
   */
  noteArrival(candidate: BlobCandidate, sizeClass: ResolvedSizeClass | null): void;
  noteDeparture(objectStorageKey: string): void;
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
   */
  function requiresProof(candidate: BlobCandidate, cls: ResolvedSizeClass): boolean {
    if (candidate.appId !== null) return true;
    return candidate.parentId === null || isPlatformClass(cls);
  }

  async function decide(candidate: BlobCandidate): Promise<ResidencyVerdict> {
    const { sizeClass, deniedHere, overrides } = await labelInputs(candidate);
    return decideResidency({
      candidate,
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

    noteArrival(candidate: BlobCandidate, sizeClass: ResolvedSizeClass | null): void {
      // A null class means the caller had no residency decision to hand over —
      // the conservative reading is the thing itself, which is what an
      // unclassified arrival has always been charged as.
      const cls = sizeClass ?? originalClassFor(candidate.type);
      index.add({
        recordId: candidate.recordId,
        objectStorageKey: candidate.objectStorageKey,
        sizeBytes: candidate.sizeBytes,
        sizeClass: cls.qualified,
        namespace: cls.namespace,
        pinned: isPinned(candidate.recordId),
        // Set by the derivation work (item 7), which is what knows whether
        // these bytes are still needed as an input here. Until then nothing is
        // marked protected, and the durability predicate is what stands
        // between the eviction pass and a last copy.
        protectedLocally: false,
        // A rendition can be re-derived; nothing else here can. Decided from
        // the record's structure rather than by testing the class name for an
        // `original:` prefix, as this once did — the prefix test was a naming
        // convention standing in for a structural fact, and the failure mode of
        // a class rename breaking it is that originals silently become
        // evictable.
        requiresDurabilityProof: requiresProof(candidate, cls),
        recencyAtMs: candidate.recencyAtMs,
        lastOpenedAtMs: candidate.lastOpenedAtMs,
        addedAtMs: Date.now(),
      });
    },

    noteDeparture(objectStorageKey: string): void {
      index.remove(objectStorageKey);
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
  onLanded(candidate: BlobCandidate, verdict: ResidencyVerdict): void;
  classOf(candidate: BlobCandidate): Promise<ResolvedSizeClass>;
} {
  return {
    decide: (candidate) => manager.decide(candidate),
    onLanded: (candidate, verdict) => manager.noteArrival(candidate, verdict.sizeClass),
    // Class without decision, for the on-demand fetch: it must charge the right
    // budget without asking a policy that is not entitled to refuse it.
    classOf: (candidate) => manager.classOf(candidate),
  };
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
