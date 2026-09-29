/**
 * Host-side residency: the facts the residency decision needs that only the
 * node running it knows.
 *
 *   - **Which node this is.** `starkeep/no-cloud` forbids the cloud and says
 *     nothing about a laptop, so only the host can turn a record constraint
 *     into "denied here".
 *   - **This node's ceilings, and whether it keeps originals.** The person
 *     sets both per node.
 *
 * A node holds every file no stand-in can replace, every stand-in at or below
 * its ceiling, every original when it keeps originals, and whatever someone
 * asked for. It removes nothing on its own;
 * "Free up space" is the one path that removes a file.
 *
 * ## Why this lives in the sync engine rather than beside a server
 *
 * The local data server and the phone both make these decisions, against the
 * same rules, and a second copy of "which bytes may this node hold" is how two
 * nodes come to disagree about what they have.
 */

import type {
  DatabaseAdapter,
  ObjectStorageAdapter,
  RawDatabase,
} from "@starkeep/storage-adapter";
import {
  ceilingPlacement,
  standardsFor,
  DEFAULT_STAND_IN_STANDARDS,
  type CeilingPlacement,
  type StandInStandards,
  type StarkeepId,
  type SyncDownCeilings,
} from "@starkeep/protocol-primitives";
import type { AcquisitionConsideration } from "./acquisition-scan.js";
import type { ReplicaProbe } from "./durability.js";
import { freeUpSpaceOn } from "./free-up-space.js";
import {
  decideResidency,
  type BlobCandidate,
  type ResidencyVerdict,
} from "./residency-policy.js";
import {
  createSqliteResidentSetIndex,
  type ReconcileReport,
  type ResidentArrival,
  type ResidentEntry,
  type ResidentSetIndex,
} from "./resident-set.js";

/** Label namespace for platform-level record constraints. */
export const STARKEEP_LABEL_APP_ID = "starkeep";
/** Record label forbidding these bytes from reaching cloud storage. */
export const NO_CLOUD_LABEL_KEY = "no-cloud";

/** The resident-set group of a file no stand-in can replace. */
export const KEPT_GROUP = "kept";

export interface ResidencyManagerOptions {
  readonly localDb: RawDatabase;
  readonly databaseAdapter: DatabaseAdapter;
  readonly localObjectStorage: ObjectStorageAdapter;
  /**
   * True when this process is the node that `starkeep/no-cloud` forbids. False
   * for a laptop or phone, which may hold no-cloud records freely — that is the
   * entire point of the flag.
   */
  readonly isCloudNode: boolean;
  /**
   * This node's sync-down ceilings — the largest fidelity per stand-in
   * category it receives without being asked. The local data server passes
   * the desktop row of `DEFAULT_SYNC_DOWN_CEILINGS` unless the person changed
   * it, and the phone passes the phone row.
   */
  readonly ceilings: SyncDownCeilings;
  /**
   * Whether this node keeps every original, as a backup machine would. An
   * original then sits within this node's ceiling whatever its fidelity: sync
   * receives it, and "Free up space" leaves it. Stand-ins still follow the
   * ceilings. Absent: originals are received only on demand.
   */
  readonly keepOriginals?: boolean;
  /** The stand-in standards the ceiling rule reads. Defaults to the platform's. */
  readonly standards?: StandInStandards;
  /**
   * Whether `localObjectStorage` answers for these bytes without holding them —
   * a phone's camera-roll alias, whose bytes belong to the device's media
   * store. Removing such a key frees nothing and loses the alias, so "Free up
   * space" skips it. Absent: every key the store has is held here.
   */
  readonly borrowsBytes?: (objectStorageKey: string) => boolean;
}

/** What "Free up space" is asked to reclaim. */
export interface FreeUpSpaceRequest {
  /** Bytes to free. The pass stops as soon as it has freed at least this many. */
  readonly bytes: number;
  /**
   * `originals`: only originals (never a self-canonical original at or below
   * the ceiling). `originals-and-above-ceiling`: those plus every stand-in
   * above the ceiling, canonical stand-ins included.
   */
  readonly scope: "originals" | "originals-and-above-ceiling";
  /** Where the cloud copies are proved. Without a probe nothing is removed. */
  readonly probes: readonly ReplicaProbe[];
  /** Prove and total, but remove nothing — the estimate a person sees first. */
  readonly dryRun?: boolean;
}

export interface FreeUpSpaceItem {
  readonly recordId: string;
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
  readonly kind: "original" | "stand-in";
}

export interface FreeUpSpaceRefusal extends FreeUpSpaceItem {
  readonly reason: "not-durable" | "no-canonical" | "record-missing";
  readonly detail: string;
}

export interface FreeUpSpaceReport {
  readonly requestedBytes: number;
  /** Removed, or — on a dry run — would be removed. */
  readonly freedBytes: number;
  readonly removed: readonly FreeUpSpaceItem[];
  readonly refused: readonly FreeUpSpaceRefusal[];
  /** Every eligible byte this node holds in the scope, whether or not proved. */
  readonly eligibleBytes: number;
  readonly dryRun: boolean;
}

export interface ResidencyManager {
  readonly index: ResidentSetIndex;
  /** The fetch-time decision, ready to hand to `createSyncEngine`. */
  decide(candidate: BlobCandidate): Promise<ResidencyVerdict>;
  /** Record that a blob landed. Called after a successful transfer. */
  noteArrival(candidate: BlobCandidate): Promise<void>;
  /** Record that this node's bytes for a key are gone. */
  noteDeparture(objectStorageKey: string): void;
  /**
   * The catalogue scan's per-record step: adopt bytes already here, queue
   * bytes this node wants and lacks, and skip the rest.
   */
  considerForAcquisition(candidate: BlobCandidate): Promise<AcquisitionConsideration>;
  /** Wanted blobs this node lacks, oldest first. */
  deferredCandidates(limit: number): ResidentEntry[];
  /** Stop wanting a queued blob the acquisition pass found unwanted or gone. */
  dropDeferred(objectStorageKey: string): void;
  /**
   * Reconcile the index against what this node's object storage actually
   * holds, correcting rows the index believed and storage does not have.
   */
  reconcile(): Promise<ReconcileReport>;
  /** Whether this node held these bytes and let them go. */
  wasEvicted(objectStorageKey: string): boolean;
  /** Bytes held per resident-set group. See {@link ResidentEntry.group}. */
  usageByGroup(): Record<string, number>;
  /**
   * The person's "Free up space": remove originals — and, in the wider scope,
   * stand-ins above the ceiling — largest first, until the requested bytes are
   * free. Each removal first proves complete cloud copies of the file, of its
   * original and of the original's canonical stand-in. Nothing runs it on its
   * own.
   */
  freeUpSpace(request: FreeUpSpaceRequest): Promise<FreeUpSpaceReport>;
  /** Where a candidate sits against this node's ceiling. */
  ceilingOf(candidate: BlobCandidate): CeilingPlacement;
  /**
   * Change this node's ceilings from now on. Removes nothing: a lowered ceiling
   * only makes the files above it removable by "Free up space". A raised one
   * reaches files earlier rounds declined through the next catalogue scan, so
   * a host that changes ceilings restarts its scan.
   */
  setCeilings(next: SyncDownCeilings): void;
}


export function createResidencyManager(options: ResidencyManagerOptions): ResidencyManager {
  const {
    localDb,
    databaseAdapter,
    localObjectStorage,
    isCloudNode,
    keepOriginals = false,
    standards = DEFAULT_STAND_IN_STANDARDS,
  } = options;

  const index = createSqliteResidentSetIndex({ db: localDb });

  let ceilings: SyncDownCeilings = options.ceilings;

  /** App-syncable rows are an app's own files, which no stand-in replaces. */
  function ceilingOf(candidate: BlobCandidate): CeilingPlacement {
    if (candidate.appId !== null || candidate.type === null) return "keep";
    const placement = ceilingPlacement(
      {
        type: candidate.type,
        parentId: candidate.parentId,
        standInRole: candidate.standInRole ?? null,
        fidelity: candidate.fidelity ?? null,
        sizeBytes: candidate.sizeBytes,
      },
      ceilings,
      standards,
    );
    // Only an original moves: a derived record is already kept, and a
    // stand-in above the ceiling stays on demand.
    const isOriginal = candidate.parentId === null && (candidate.standInRole ?? null) === null;
    return keepOriginals && isOriginal && placement === "above" ? "within" : placement;
  }

  function groupOf(candidate: BlobCandidate): string {
    const category =
      candidate.type === null ? null : standardsFor(candidate.type, standards)?.category ?? null;
    if (category === null || ceilingOf(candidate) === "keep") return KEPT_GROUP;
    return `${candidate.standInRole ? "stand-in" : "original"}:${category}`;
  }

  function arrivalOf(candidate: BlobCandidate): ResidentArrival {
    return {
      recordId: candidate.recordId,
      objectStorageKey: candidate.objectStorageKey,
      sizeBytes: candidate.sizeBytes,
      group: groupOf(candidate),
      addedAtMs: Date.now(),
    };
  }

  /**
   * Whether a record constraint forbids these bytes here. Only the cloud node
   * has one to honour: a laptop or phone may hold a no-cloud record freely,
   * and reading it as "nobody may hold this" would turn a privacy preference
   * into data loss.
   */
  async function deniedHere(candidate: BlobCandidate): Promise<boolean> {
    if (!isCloudNode || candidate.appId !== null) return false;
    const recordId = candidate.recordId as StarkeepId;
    const byRecord = await databaseAdapter.getLabelsByRecordIds([recordId]);
    return (byRecord.get(recordId) ?? []).some(
      (l) => !l.deletedAt && l.appId === STARKEEP_LABEL_APP_ID && l.key === NO_CLOUD_LABEL_KEY,
    );
  }

  async function decide(candidate: BlobCandidate): Promise<ResidencyVerdict> {
    return decideResidency({
      constraints: { deniedHere: await deniedHere(candidate) },
      placement: ceilingOf(candidate),
    });
  }

  return {
    index,
    decide,
    ceilingOf,

    setCeilings(next) {
      ceilings = next;
    },

    async noteArrival(candidate) {
      index.add(arrivalOf(candidate));
    },

    noteDeparture(objectStorageKey) {
      index.markDeparted(objectStorageKey);
    },

    async considerForAcquisition(candidate) {
      const existing = index.get(candidate.objectStorageKey);
      if (existing?.resident) return "held";
      // Bytes that arrived by a route that never passed through a round — a
      // local import, a derived stand-in, a watcher — are adopted here, once,
      // so the next scan answers from the index rather than from storage.
      if (existing === null && (await localObjectStorage.has(candidate.objectStorageKey))) {
        index.add(arrivalOf(candidate));
        return "held";
      }
      const verdict = await decide(candidate);
      if (verdict.decision !== "fetch") {
        if (existing?.wanted) index.dropDeferred(candidate.objectStorageKey);
        return "unwanted";
      }
      index.defer(arrivalOf(candidate));
      return "queued";
    },

    deferredCandidates(limit) {
      return index.deferredCandidates(limit);
    },

    dropDeferred(objectStorageKey) {
      index.dropDeferred(objectStorageKey);
    },

    reconcile() {
      return index.reconcile(localObjectStorage);
    },

    wasEvicted(objectStorageKey) {
      return index.wasEvicted(objectStorageKey);
    },

    usageByGroup() {
      return index.usageByGroup();
    },

    async freeUpSpace(request) {
      return freeUpSpaceOn(
        {
          databaseAdapter,
          localObjectStorage,
          ceilingOf,
          standards,
          ...(options.borrowsBytes ? { borrowsBytes: options.borrowsBytes } : {}),
          noteRemoved: async (candidate) => {
            if (index.get(candidate.objectStorageKey) === null) index.add(arrivalOf(candidate));
            index.markDeparted(candidate.objectStorageKey);
          },
        },
        request,
      );
    },
  };
}

/**
 * Adapt a manager into the hooks the sync engine takes: decide, and record
 * what landed.
 */
export function residencyHooks(manager: ResidencyManager): {
  decide(candidate: BlobCandidate): Promise<ResidencyVerdict>;
  onLanded(candidate: BlobCandidate): Promise<void>;
} {
  return {
    decide: (candidate) => manager.decide(candidate),
    onLanded: (candidate) => manager.noteArrival(candidate),
  };
}
