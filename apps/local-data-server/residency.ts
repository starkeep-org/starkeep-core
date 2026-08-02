/**
 * Host-side residency: everything the platform deliberately refuses to know.
 *
 * `@starkeep/sync-engine` owns the *shape* of the residency decision — the
 * resolution order, the keep rules, the budgets, the durability predicate —
 * and knows nothing about what a size class is or which node it is running on.
 * This module supplies both, because they are host facts:
 *
 *   - **Which class a record belongs to.** Resolved from a configured label key
 *     (`photos/rendition` today), falling back to `original:<category>` for
 *     anything with no such label. Nothing here hard-codes a class name, so the
 *     ladder can be respecified without touching this file.
 *   - **Which node this is.** `starkeep/no-cloud` forbids the cloud and says
 *     nothing about a laptop, so only the host can turn a record constraint
 *     into "denied here".
 *   - **Pins.** Node-local, deliberately not a label: a pin shared as a label
 *     would let one device's preference silently rewrite every other device's
 *     cache policy. That is the expensive mistake available in this area.
 */

import {
  evaluateOverrides,
  NO_OVERRIDES,
  type OverrideRule,
  type OverrideVerdict,
} from "../../packages/sync-engine/src/index.js";
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
  previewBudgetReduction,
  validateRetentionPolicy,
  type BlobCandidate,
  type DurabilityPolicy,
  type EvictionOutcome,
  type NodeRetentionPolicy,
  type ReductionPreview,
  type ReplicaProbe,
  type ResidencyVerdict,
  type ResidentSetIndex,
} from "@starkeep/sync-engine";
import { typeCategory } from "../../packages/protocol-primitives/src/types/core-types.js";
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

export function originalClassFor(type: string | null): string {
  return `${ORIGINAL_CLASS_PREFIX}:${type === null ? "other" : typeCategory(type)}`;
}

export interface ResidencyManagerOptions {
  readonly localDb: RawDatabase;
  readonly databaseAdapter: DatabaseAdapter;
  readonly localObjectStorage: ObjectStorageAdapter;
  /**
   * Which label names a record's size class. Configured rather than constant so
   * the platform-side plumbing never names `photos/rendition`, and a second
   * ladder-owning app would not require a code change here.
   */
  readonly classLabel: { readonly appId: string; readonly key: string };
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
  noteArrival(candidate: BlobCandidate, sizeClass: string | null): void;
  noteDeparture(objectStorageKey: string): void;
  isPinned(recordId: string): boolean;
  setPinned(recordId: string, pinned: boolean): void;
  markOpened(recordId: string, atMs: number): void;
  classOf(candidate: BlobCandidate): Promise<string | null>;
  usageByClass(): Record<string, number>;
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
    classLabel,
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
  ): Promise<{ sizeClass: string | null; deniedHere: boolean; overrides: OverrideVerdict }> {
    // App-syncable blobs are not part of anyone's rendition ladder and carry no
    // shared-record labels; they fall to the policy's fallback row.
    if (candidate.appId !== null) {
      return { sizeClass: null, deniedHere: false, overrides: NO_OVERRIDES };
    }

    // BlobCandidate carries ids as plain strings — the sync engine normalizes
    // shared records and app-syncable rows into one shape, and only the former
    // have StarkeepIds.
    const recordId = candidate.recordId as StarkeepId;
    const byRecord = await databaseAdapter.getLabelsByRecordIds([recordId]);
    const labels = (byRecord.get(recordId) ?? []).filter((l) => !l.deletedAt);

    const classValue = labels.find(
      (l) => l.appId === classLabel.appId && l.key === classLabel.key && l.value !== "",
    )?.value;

    return {
      // Evaluated from the same label read, not a second query. Rules are the
      // scalable form of a pin — "keep every photo of my daughter" is one
      // sentence and five thousand records, and pinning ids would freeze that
      // intent at pin time so every later photo silently falls outside it.
      overrides: evaluateOverrides(overrideRules, labels),
      // No rendition label means this *is* the thing itself.
      sizeClass: classValue ?? originalClassFor(candidate.type),
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

  async function classOf(candidate: BlobCandidate): Promise<string | null> {
    return (await labelInputs(candidate)).sizeClass;
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
      usage: (cls) => (cls === null ? 0 : index.usageOf(cls)),
    });
  }

  return {
    index,
    decide,
    classOf,
    isPinned,

    noteArrival(candidate: BlobCandidate, sizeClass: string | null): void {
      index.add({
        recordId: candidate.recordId,
        objectStorageKey: candidate.objectStorageKey,
        sizeBytes: candidate.sizeBytes,
        sizeClass: sizeClass ?? originalClassFor(candidate.type),
        pinned: isPinned(candidate.recordId),
        // Set by the derivation work (item 7), which is what knows whether
        // these bytes are still needed as an input here. Until then nothing is
        // marked protected, and the durability predicate is what stands
        // between the eviction pass and a last copy.
        protectedLocally: false,
        // A rendition can be re-derived; the thing itself cannot. Anything
        // unclassified is treated as irreplaceable, because the cost of being
        // wrong is asymmetric.
        requiresDurabilityProof:
          sizeClass === null || sizeClass.startsWith(`${ORIGINAL_CLASS_PREFIX}:`),
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

    async runEviction(probes: readonly ReplicaProbe[]): Promise<EvictionOutcome[]> {
      const outcomes: EvictionOutcome[] = [];
      // Per class, so a full video budget evicts video and does not touch
      // stills. Classes with no held bytes are skipped rather than evaluated.
      for (const sizeClass of Object.keys(index.usageByClass())) {
        outcomes.push(
          await evictClass({
            sizeClass,
            index,
            policy,
            localStorage: localObjectStorage,
            probes,
            durability,
            contentHashOf: (entry) => contentHashOfKey(entry.objectStorageKey),
          }),
        );
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
} {
  return {
    decide: (candidate) => manager.decide(candidate),
    onLanded: (candidate, verdict) => manager.noteArrival(candidate, verdict.sizeClass),
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
