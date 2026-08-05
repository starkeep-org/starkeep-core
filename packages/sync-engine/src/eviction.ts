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
 *
 * ## Two budgets, two passes
 *
 * A class row is not the only cap: an app also has a total across every rung it
 * holds, and the two fail independently. An app can sit inside every one of its
 * rows and still be over its total — that is the whole reason the total exists,
 * since a fallback row is per-rung and an app inventing rung names would
 * otherwise get a fresh budget with each one. So {@link evictNamespace} runs the
 * same pass over a wider scope: same ordering, same refusals, different `WHERE`.
 */

import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { assessDurability, type DurabilityPolicy, type ReplicaProbe } from "./durability.js";
import type { EvictionScope, ResidentEntry, ResidentSetIndex } from "./resident-set.js";
import {
  namespaceTotalFor,
  parseSizeClass,
  retentionRowFor,
  type NodeRetentionPolicy,
} from "./residency-policy.js";

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
  /**
   * Which budget this pass was enforcing — one class's row, or one app's total.
   *
   * Carried as the scope rather than a bare class name because the two passes
   * report the same fields about different things, and a caller reading
   * `bytesBefore` needs to know whether it is a rung or a whole namespace.
   */
  readonly scope: EvictionScope;
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
  /**
   * Set when the pass could not proceed on the evidence available — today, when
   * there is no peer to ask and something needed asking about.
   *
   * The same sentence `ReductionPreview.refusal` gives an operator, from the
   * pass that actually deletes. Its absence here was the asymmetry: a preview
   * would say "no peer is available to confirm these survive elsewhere, nothing
   * was removed", and the pass doing the deleting would silently report a
   * shortfall with no reason attached.
   */
  readonly refusal: string | null;
}

/** Everything a pass needs apart from which budget it is enforcing. */
export interface EvictionRequest {
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
  /**
   * Whether this host can actually re-derive a rendition it deletes.
   *
   * **Defaults to false, and that default is the point.** The pass skips the
   * durability check entirely for anything with `requiresDurabilityProof: false`
   * — a rendition — on the stated grounds that a rendition can be made again.
   * That is a claim about the *host*, not about the bytes, and on this branch it
   * is not true: the derivation work is unimplemented, so a deleted rendition is
   * gone until it is written for the first time. The rest of this file is
   * scrupulous about failing closed, and this was the one place a capability
   * nobody had was assumed.
   *
   * A host that has derivation passes true and gets the cheap path back. The
   * same dependency runs the other way through `protectedLocally`, which is
   * hardwired false pending the same work — so until it lands, the durability
   * predicate is the only thing standing between this pass and a last copy, and
   * it should be asked about renditions too.
   */
  readonly canRederive?: boolean;
}

/**
 * The refusal both passes owe an operator when nothing can confirm anything.
 *
 * `previewBudgetReduction` had this and the loop that actually deletes did not.
 * The loop was saved only by the arithmetic in `assessDurability` — `counted >=
 * minimumReplicas` is false at zero probes *as long as* the minimum is at least
 * one — which is exactly the invariant `MINIMUM_REPLICAS_FLOOR` had to be
 * introduced to hold, and exactly the invariant a config value of `0` used to
 * break. One predicate, called by both, so neither can be quietly deleting on no
 * evidence because of arithmetic happening elsewhere.
 *
 * Returns null when there is nothing to refuse: no probes but nothing that
 * needed them (a class of re-derivable renditions on a host that can re-derive),
 * or probes that simply did not confirm.
 */
function noProbeRefusal(
  what: string,
  probes: readonly ReplicaProbe[],
  keptForWantOfProof: number,
): string | null {
  if (probes.length > 0 || keptForWantOfProof === 0) return null;
  return (
    `Cannot free ${what}: no peer is available to confirm that ${keptForWantOfProof} blob(s) ` +
    `survive elsewhere. Nothing was removed that needed proof.`
  );
}

/**
 * Run one eviction pass over a single size class, against that class's row.
 *
 * Deletes through the storage adapter **first** and updates the index after,
 * so a crash between the two leaves a stale index row (harmless, self-correcting
 * on the next pass) rather than a phantom file the index has forgotten.
 */
export async function evictClass(
  request: EvictionRequest & { readonly sizeClass: string },
): Promise<EvictionOutcome> {
  const { sizeClass, policy } = request;
  // A stored class name that does not parse is one written before namespacing.
  // `retentionRowFor` sends it to the platform fallback, which is the
  // conservative row — the same place an unresolvable class has always gone.
  const budget = retentionRowFor(policy, parseSizeClass(sizeClass)).budgetBytes;
  return runPass({ kind: "class", sizeClass }, budget, request.index.usageOf(sizeClass), request);
}

/**
 * Run one eviction pass over a whole app namespace, against that app's total.
 *
 * Needed because the two budgets fail independently: an app can be over its
 * total while every one of its classes is inside its own row, and a per-class
 * pass would then find nothing to do and leave the total breached forever.
 *
 * Ordering is unchanged — worst-to-keep-first across every rung the app holds,
 * so the pass drops the app's least useful bytes rather than picking on
 * whichever class happens to be largest.
 */
export async function evictNamespace(
  request: EvictionRequest & { readonly namespace: string },
): Promise<EvictionOutcome> {
  const { namespace, policy, index } = request;
  const bytesBefore = index.usageOfNamespace(namespace);
  const total = namespaceTotalFor(policy, namespace);
  if (total === null) {
    // The platform namespace has no total — its rows are the whole story, and
    // a cap above them would be a second way to say the same thing.
    return untriggered({ kind: "namespace", namespace }, bytesBefore);
  }
  return runPass({ kind: "namespace", namespace }, total, bytesBefore, request);
}

function untriggered(scope: EvictionScope, bytesBefore: number): EvictionOutcome {
  return {
    scope,
    triggered: false,
    bytesBefore,
    bytesAfter: bytesBefore,
    evicted: [],
    kept: [],
    shortfall: false,
    corruptionSuspected: [],
    refusal: null,
  };
}

/**
 * The pass itself, shared by both budgets.
 *
 * One body deliberately: this is the loop that deletes user data, and the one
 * thing worse than a bug in it is two copies of it that drift.
 *
 * ## `bytesBefore` and `bytesAfter` are a snapshot and a running subtraction
 *
 * `bytesBefore` is read once, before the loop; `bytesAfter` is it minus what
 * this pass deleted. Neither observes a *concurrent arrival*, and a pass is not
 * instantaneous — the durability probes are network calls, so a long one can run
 * while a sync round lands new bytes into the same class. `shortfall` is
 * therefore computed against a figure that may be stale by whatever landed
 * meanwhile.
 *
 * Left as is rather than re-read at the end, and the reason is that re-reading
 * would be *worse*: it would attribute bytes this pass never considered to this
 * pass's outcome, so a class that received a 400 MB video mid-sweep would report
 * that the eviction failed. A stale figure understates progress once; a fresh
 * one misreports the cause. The next pass sees the real number either way.
 */
async function runPass(
  scope: EvictionScope,
  budget: number,
  bytesBefore: number,
  request: EvictionRequest,
): Promise<EvictionOutcome> {
  const { index, localStorage, probes, durability, contentHashOf } = request;
  const marks = request.waterMarks ?? DEFAULT_WATER_MARKS;
  const keepLastInstantCopy = request.keepLastInstantCopy ?? true;
  const canRederive = request.canRederive ?? false;

  // A budget that is not a number is not a small budget — it is no answer at
  // all, and an unanswered question must not authorize deletion. Refused here
  // as well as in `validateRetentionPolicy` because this is the loop that
  // deletes user data: every comparison below is false against a NaN, so the
  // pass would trigger and then never reach its target, taking the whole scope
  // with it. Zero is left alone, because zero is a real answer — it is what
  // `keep: "never"` means, and evicting everything is the point.
  if (!Number.isFinite(budget)) {
    return untriggered(scope, bytesBefore);
  }

  if (bytesBefore <= budget * marks.high) {
    return untriggered(scope, bytesBefore);
  }

  const target = budget * marks.low;
  // Over-collect: some candidates will be refused, and a pass that collected
  // exactly the shortfall would stop short every time anything was protected.
  const candidates = index.evictionCandidates({
    scope,
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

    // A rendition skips the durability check on the grounds that it can be made
    // again — which is a claim about the host, not about the bytes, and is false
    // wherever derivation is not implemented. `canRederive` makes that
    // dependency explicit and defaults to false, so an unimplemented derivation
    // makes this pass *more* careful rather than silently less.
    if (entry.requiresDurabilityProof || !canRederive) {
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
    // Marked departed, not removed. The row is the only durable record that this
    // node held these bytes and let them go, and without it `residencyOf`
    // reports an evicted blob as `staged` — "still owed" — for bytes the peer
    // will never offer again, because eliding and eviction both leave the
    // watermark above the record.
    index.markDeparted(entry.objectStorageKey);
    evicted.push(entry);
    held -= entry.sizeBytes;
  }

  return {
    scope,
    triggered: true,
    bytesBefore,
    bytesAfter: held,
    evicted,
    kept,
    shortfall: held > target,
    corruptionSuspected,
    refusal: noProbeRefusal(
      scope.kind === "class" ? `"${scope.sizeClass}"` : `namespace "${scope.namespace}"`,
      probes,
      kept.filter((k) => k.reason === "not-confirmed-elsewhere").length,
    ),
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
   * Bytes in this class that no reduction can free — pinned, or locally
   * protected.
   *
   * Reported because the two numbers this preview was built from disagree about
   * them: `usageOf` counts pinned bytes toward the class, and
   * `evictionCandidates` excludes them from what may be dropped. Without this
   * figure the preview computed a shortfall it could not name, ran out of
   * candidates before reaching the target, and reported `wouldEvictBytes` short
   * of the gap with `refusal: null` — "confirm and this class will fit", when it
   * will not.
   *
   * This also grows in importance rather than shrinking: `protectedLocally` is
   * hardwired false today and will not stay that way once derivation lands.
   */
  readonly unevictableBytes: number;
  /**
   * True when the class cannot reach `newBudgetBytes` even if the operator
   * confirms everything on offer.
   *
   * The honest version of the sentence a confirmation prompt needs: "12 GB of
   * this class is pinned and will remain." `EvictionOutcome` has always carried
   * this and the preview did not, which is how the preview came to promise an
   * outcome the pass could not deliver.
   */
  readonly shortfall: boolean;
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
  // Includes pinned and locally protected bytes, which `held` counts and
  // `evictionCandidates` will not offer. The gap between those two facts is what
  // made this preview promise targets it could not reach.
  const unevictableBytes = index.unevictableBytesOf({ kind: "class", sizeClass });
  if (held <= newBudgetBytes) {
    return {
      sizeClass,
      newBudgetBytes,
      wouldEvictCount: 0,
      wouldEvictBytes: 0,
      keptNotConfirmedCount: 0,
      keptNotConfirmedBytes: 0,
      unevictableBytes,
      shortfall: false,
      refusal: null,
    };
  }

  const candidates = index.evictionCandidates({
    scope: { kind: "class", sizeClass },
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
  // asked for a reduction and is entitled to know it did not happen. Shared with
  // the pass that actually deletes, so the two cannot drift.
  const refusal = noProbeRefusal(
    `"${sizeClass}"`,
    probes,
    keptCount > 0 || unprovable > 0 ? Math.max(keptCount, 1) : 0,
  );

  return {
    sizeClass,
    newBudgetBytes,
    wouldEvictCount,
    wouldEvictBytes,
    keptNotConfirmedCount: keptCount,
    keptNotConfirmedBytes: keptBytes,
    unevictableBytes,
    // What is left after everything on offer goes. Pinned and protected bytes
    // stay whatever the operator confirms, so a class whose pins alone exceed
    // the new budget cannot reach it and the prompt has to say so.
    shortfall: held - wouldEvictBytes > newBudgetBytes,
    refusal,
  };
}
