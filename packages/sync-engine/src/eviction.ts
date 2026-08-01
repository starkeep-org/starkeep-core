/**
 * Eviction — deleting an already-resident blob.
 *
 * The plan (§6.3) names three distinct mechanisms and only the first is the
 * residency decision:
 *
 *   1. **Decline** — never fetch. Fetch-time, `decideResidency` → `"elide"`.
 *      Bounds new arrivals only. Lives in `residency-policy.ts`.
 *   2. **Evict** — delete something already held. This file.
 *   3. **Backpressure** — what happens when eviction cannot free enough.
 *      {@link shedLoad} below.
 *
 * Conflating 1 and 2 is tempting and wrong: declining costs nothing and can be
 * reconsidered, while evicting is irreversible from this node's point of view.
 * They therefore have different bars — declining needs only a budget, evicting
 * needs proof the bytes survive elsewhere.
 *
 * ## Hysteresis, per class
 *
 * A single threshold makes a full budget evict on every single arrival. So:
 * cross the **high-water mark** (default 95%) to trigger, then free down to the
 * **low-water mark** (default 80%). Evaluated per class, so a full video budget
 * evicts video and does not touch stills.
 */

import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { assessDurability, type DurabilityPolicy, type ReplicaProbe } from "./durability.js";
import type { ResidentEntry, ResidentSetIndex } from "./resident-set.js";
import type { NodeRetentionPolicy } from "./residency-policy.js";

export interface WaterMarks {
  /** Fraction of budget at which eviction triggers. Default 0.95. */
  readonly high: number;
  /** Fraction of budget to free down to once triggered. Default 0.80. */
  readonly low: number;
}

export const DEFAULT_WATER_MARKS: WaterMarks = { high: 0.95, low: 0.8 };

/** Why a blob was kept when the pass wanted to drop it. */
export type RetentionReason =
  | "pinned"
  | "protected-locally"
  | "not-confirmed-elsewhere"
  | "last-instantly-readable-copy";

export interface EvictionOutcome {
  readonly sizeClass: string;
  readonly triggered: boolean;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly evicted: readonly ResidentEntry[];
  /** Wanted to evict, refused to. Each carries its reason. */
  readonly kept: readonly { entry: ResidentEntry; reason: RetentionReason }[];
  /**
   * True when the pass could not reach the low-water mark. The caller must
   * apply backpressure ({@link shedLoad}) rather than treating this as done.
   */
  readonly shortfall: boolean;
  /**
   * Keys whose replicas disagreed about size or checksum. Not a "couldn't
   * evict" condition — evidence that a copy somewhere is corrupt, which should
   * reach a human rather than merely suppressing an eviction.
   */
  readonly corruptionSuspected: readonly string[];
}

export interface EvictionRequest {
  readonly sizeClass: string;
  readonly index: ResidentSetIndex;
  readonly policy: NodeRetentionPolicy;
  readonly localStorage: ObjectStorageAdapter;
  readonly probes: readonly ReplicaProbe[];
  readonly durability: DurabilityPolicy;
  readonly waterMarks?: WaterMarks;
  /**
   * Content hash for a held key, from the record. Needed to verify a replica
   * is the *right* bytes and not merely something at that key.
   */
  readonly contentHashOf: (entry: ResidentEntry) => string | null;
  /**
   * When true, refuse to drop the last copy that can be read *now*, even
   * though an archived copy makes the bytes durable. Default true: the two
   * mistakes are not symmetric — a needless refusal costs disk, and a wrong
   * drop costs someone a twelve-hour wait to see their own photo.
   */
  readonly keepLastInstantCopy?: boolean;
}

/**
 * Run one eviction pass over a single size class.
 *
 * Deletes through the storage adapter **first** and updates the index after,
 * so a crash between the two leaves a stale index row (harmless, self-correcting
 * on the next pass) rather than a phantom file the index has forgotten.
 */
export async function evictClass(request: EvictionRequest): Promise<EvictionOutcome> {
  const {
    sizeClass,
    index,
    policy,
    localStorage,
    probes,
    durability,
    contentHashOf,
  } = request;
  const marks = request.waterMarks ?? DEFAULT_WATER_MARKS;
  const keepLastInstantCopy = request.keepLastInstantCopy ?? true;

  const row = policy.rows[sizeClass] ?? policy.fallback;
  const bytesBefore = index.usageOf(sizeClass);
  const budget = row.budgetBytes;

  if (bytesBefore <= budget * marks.high) {
    return {
      sizeClass,
      triggered: false,
      bytesBefore,
      bytesAfter: bytesBefore,
      evicted: [],
      kept: [],
      shortfall: false,
      corruptionSuspected: [],
    };
  }

  const target = budget * marks.low;
  // Over-collect: some candidates will be refused, and a pass that collected
  // exactly the shortfall would stop short every time anything was protected.
  const candidates = index.evictionCandidates({
    sizeClass,
    targetBytes: (bytesBefore - target) * 2,
  });

  const evicted: ResidentEntry[] = [];
  const kept: { entry: ResidentEntry; reason: RetentionReason }[] = [];
  const corruptionSuspected: string[] = [];
  let held = bytesBefore;

  for (const entry of candidates) {
    if (held <= target) break;

    // evictionCandidates already excludes these, but the check is repeated
    // because this is the loop that deletes data and a silent change to the
    // query upstream must not become a data-loss bug down here.
    if (entry.pinned) {
      kept.push({ entry, reason: "pinned" });
      continue;
    }
    if (entry.protectedLocally) {
      kept.push({ entry, reason: "protected-locally" });
      continue;
    }

    if (entry.requiresDurabilityProof) {
      const contentHash = contentHashOf(entry);
      if (contentHash === null) {
        // No hash means no way to tell a correct replica from an object that
        // merely occupies the key. Refuse.
        kept.push({ entry, reason: "not-confirmed-elsewhere" });
        continue;
      }
      const verdict = await assessDurability(
        {
          objectStorageKey: entry.objectStorageKey,
          contentHash,
          sizeBytes: entry.sizeBytes,
        },
        probes,
        durability,
      );
      if (verdict.corruptionSuspected) {
        corruptionSuspected.push(entry.objectStorageKey);
      }
      if (!verdict.durable) {
        kept.push({ entry, reason: "not-confirmed-elsewhere" });
        continue;
      }
      if (keepLastInstantCopy && verdict.instantReplicas === 0) {
        kept.push({ entry, reason: "last-instantly-readable-copy" });
        continue;
      }
    }

    await localStorage.delete(entry.objectStorageKey);
    index.remove(entry.objectStorageKey);
    evicted.push(entry);
    held -= entry.sizeBytes;
  }

  return {
    sizeClass,
    triggered: true,
    bytesBefore,
    bytesAfter: held,
    evicted,
    kept,
    shortfall: held > target,
    corruptionSuspected,
  };
}

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

/**
 * The fixed order in which a node sheds load when eviction cannot free enough.
 *
 * **Capture never blocks.** Whatever this device just recorded is the one thing
 * in the system that exists nowhere else, so it is the last thing that may be
 * refused — which means everything else has to give way first, in a defined
 * order rather than whichever check happens to run.
 */
export const SHED_ORDER = [
  /** Stop pulling other nodes' renditions for this class. */
  "stop-fetching-peer-renditions",
  /** Stop prefetching this class's recency window. */
  "stop-prefetching-recency-window",
  /** Ask the operator to raise the budget or unpin something. */
  "prompt-raise-budget-or-unpin",
] as const;

export type ShedStep = (typeof SHED_ORDER)[number];

/**
 * How far down the shed order a class has been pushed. `null` means no
 * backpressure: the class is inside its budget and everything runs normally.
 */
export function shedLoad(outcome: EvictionOutcome, alreadyAt: ShedStep | null): ShedStep | null {
  if (!outcome.shortfall) return null;
  const nextIndex = alreadyAt === null ? 0 : SHED_ORDER.indexOf(alreadyAt) + 1;
  return SHED_ORDER[Math.min(nextIndex, SHED_ORDER.length - 1)]!;
}

// ---------------------------------------------------------------------------
// Budget reduction
// ---------------------------------------------------------------------------

export interface ReductionPreview {
  readonly sizeClass: string;
  readonly newBudgetBytes: number;
  /** What would be removed if the operator confirms. */
  readonly wouldEvictCount: number;
  readonly wouldEvictBytes: number;
  /**
   * Excluded from the reduction because they are not confirmed to survive
   * elsewhere, reported separately rather than silently dropped or silently
   * kept. These leave later, when they qualify.
   */
  readonly keptNotConfirmedCount: number;
  readonly keptNotConfirmedBytes: number;
  /**
   * Set when the reduction cannot proceed at all. The plan is explicit: until
   * the durability predicate can answer, a reduction that would evict
   * originals must **refuse rather than proceed, and say so**.
   */
  readonly refusal: string | null;
}

/**
 * Compute the impact of lowering a class's budget, without doing anything.
 *
 * Lowering a budget is a destructive action, so it is a two-step: this
 * produces the numbers a confirmation prompt needs ("12,431 originals will be
 * removed; 47 kept because they are not yet confirmed elsewhere"), and only an
 * explicit confirmation runs {@link evictClass}.
 */
export async function previewBudgetReduction(request: {
  readonly sizeClass: string;
  readonly newBudgetBytes: number;
  readonly index: ResidentSetIndex;
  readonly probes: readonly ReplicaProbe[];
  readonly durability: DurabilityPolicy;
  readonly contentHashOf: (entry: ResidentEntry) => string | null;
}): Promise<ReductionPreview> {
  const { sizeClass, newBudgetBytes, index, probes, durability, contentHashOf } = request;

  const held = index.usageOf(sizeClass);
  if (held <= newBudgetBytes) {
    return {
      sizeClass,
      newBudgetBytes,
      wouldEvictCount: 0,
      wouldEvictBytes: 0,
      keptNotConfirmedCount: 0,
      keptNotConfirmedBytes: 0,
      refusal: null,
    };
  }

  const candidates = index.evictionCandidates({
    sizeClass,
    targetBytes: held - newBudgetBytes,
  });

  let wouldEvictCount = 0;
  let wouldEvictBytes = 0;
  let keptCount = 0;
  let keptBytes = 0;
  let unprovable = 0;

  for (const entry of candidates) {
    if (!entry.requiresDurabilityProof) {
      wouldEvictCount += 1;
      wouldEvictBytes += entry.sizeBytes;
      continue;
    }
    const contentHash = contentHashOf(entry);
    if (contentHash === null) {
      unprovable += 1;
      keptCount += 1;
      keptBytes += entry.sizeBytes;
      continue;
    }
    const verdict = await assessDurability(
      { objectStorageKey: entry.objectStorageKey, contentHash, sizeBytes: entry.sizeBytes },
      probes,
      durability,
    );
    if (verdict.durable) {
      wouldEvictCount += 1;
      wouldEvictBytes += entry.sizeBytes;
    } else {
      keptCount += 1;
      keptBytes += entry.sizeBytes;
    }
  }

  // No probes at all means the predicate cannot answer for anything. Proceeding
  // would delete originals on no evidence whatsoever, so the reduction is
  // refused rather than silently degraded into "keep everything" — the operator
  // asked for a reduction and is entitled to know it did not happen.
  const refusal =
    probes.length === 0 && (keptCount > 0 || unprovable > 0)
      ? `Cannot reduce "${sizeClass}": no peer is available to confirm that ${keptCount} blob(s) survive elsewhere. Nothing was removed.`
      : null;

  return {
    sizeClass,
    newBudgetBytes,
    wouldEvictCount,
    wouldEvictBytes,
    keptNotConfirmedCount: keptCount,
    keptNotConfirmedBytes: keptBytes,
    refusal,
  };
}
