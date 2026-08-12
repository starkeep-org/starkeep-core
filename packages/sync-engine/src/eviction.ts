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
 * That asymmetry is why this file did not shrink when the policy did. The
 * retention table lost two thirds of its vocabulary because it was predicting
 * what this pass would do; the evidence this pass demands before it deletes
 * anything is the part that was never a prediction.
 *
 * ## One level, per budget line
 *
 * A pass triggers when a line is **over its budget** and frees down to
 * **exactly its budget**. Evaluated per line, so a full video budget evicts
 * video and does not touch stills.
 *
 * This used to be two fractions — trigger at 95%, free to 80% — as hysteresis
 * against evicting on every single arrival. Both are gone, and the reason they
 * could go is worth stating, because the arithmetic looks like a regression
 * until you see what replaced it:
 *
 *   - **Something now refills a line.** The acquisition pass fills back up to
 *     the budget, so any gap between where eviction stops and where acquisition
 *     stops is a pump: free to 80%, refill to 100%, free again — re-downloading
 *     a fifth of every budget for ever, which on a 4 GB line is ~600 MB per
 *     cycle. Two levels can only be safe while nothing reclaims the headroom
 *     between them, and that stopped being true.
 *   - **The batching hysteresis bought is now the job graph's.** Eviction is a
 *     scheduled job that runs after a fetch pass has admitted many blobs, not
 *     an inline reaction to each arrival. And the expensive part of a pass — a
 *     durability probe and a delete **per candidate** — is linear in bytes
 *     freed however the work is grouped. What batching actually saved was two
 *     SQLite queries per pass.
 *
 * So the budget is the only number, and "the budget is the budget" is a much
 * easier sentence to keep true than three fractions that have to agree.
 *
 * ## One pass, because there is one budget
 *
 * There used to be two: a per-class row and a namespace-wide total, checked
 * independently, with a second pass over whole namespaces because an app could
 * sit inside every row and still breach its total. Rows now carry *shares* of
 * one namespace budget, so the lines of a namespace sum to it exactly
 * (`budgetBytesFor`) and a node inside every line is inside its namespace by
 * construction. The second pass had nothing left to catch and is gone.
 */

import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { assessDurability, type DurabilityPolicy, type ReplicaProbe } from "./durability.js";
import type { ResidentEntry, ResidentSetIndex } from "./resident-set.js";
import {
  budgetBytesFor,
  type BudgetLine,
  type NodeRetentionPolicy,
} from "./residency-policy.js";


/** Why a blob was kept when the pass wanted to drop it. */
export type RetentionReason =
  | "pinned"
  | "protected-locally"
  | "not-confirmed-elsewhere"
  | "last-instantly-readable-copy";

export interface EvictionOutcome {
  /** Which budget this pass was enforcing. */
  readonly budgetLine: BudgetLine;
  readonly triggered: boolean;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly evicted: readonly ResidentEntry[];
  /** Wanted to evict, refused to. Each carries its reason. */
  readonly kept: readonly { entry: ResidentEntry; reason: RetentionReason }[];
  /**
   * True when the pass could not free the line back to its budget. The caller
   * must apply backpressure ({@link shedLoad}) rather than treating this as
   * done.
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
 * needed them (a line of re-derivable renditions on a host that can re-derive),
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
 * Run one eviction pass over a single budget line.
 *
 * Deletes through the storage adapter **first** and updates the index after,
 * so a crash between the two leaves a stale index row (harmless, self-correcting
 * on the next pass) rather than a phantom file the index has forgotten.
 */
export async function evictLine(
  request: EvictionRequest & { readonly budgetLine: BudgetLine },
): Promise<EvictionOutcome> {
  const { budgetLine, policy, index } = request;
  return runPass(budgetLine, budgetBytesFor(policy, budgetLine), index.usageOf(budgetLine.key), request);
}

function untriggered(budgetLine: BudgetLine, bytesBefore: number): EvictionOutcome {
  return {
    budgetLine,
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
 * The pass itself.
 *
 * ## `bytesBefore` and `bytesAfter` are a snapshot and a running subtraction
 *
 * `bytesBefore` is read once, before the loop; `bytesAfter` is it minus what
 * this pass deleted. Neither observes a *concurrent arrival*, and a pass is not
 * instantaneous — the durability probes are network calls, so a long one can run
 * while a sync round lands new bytes into the same line. `shortfall` is
 * therefore computed against a figure that may be stale by whatever landed
 * meanwhile.
 *
 * Left as is rather than re-read at the end, and the reason is that re-reading
 * would be *worse*: it would attribute bytes this pass never considered to this
 * pass's outcome, so a line that received a 400 MB video mid-sweep would report
 * that the eviction failed. A stale figure understates progress once; a fresh
 * one misreports the cause. The next pass sees the real number either way.
 */
async function runPass(
  budgetLine: BudgetLine,
  budget: number,
  bytesBefore: number,
  request: EvictionRequest,
): Promise<EvictionOutcome> {
  const { index, localStorage, probes, durability, contentHashOf } = request;
  const keepLastInstantCopy = request.keepLastInstantCopy ?? true;
  const canRederive = request.canRederive ?? false;

  // A budget that is not a number is not a small budget — it is no answer at
  // all, and an unanswered question must not authorize deletion. Refused here
  // as well as in `validateRetentionPolicy` because this is the loop that
  // deletes user data: every comparison below is false against a NaN, so the
  // pass would trigger and then never reach its target, taking the whole line
  // with it. Zero is left alone, because zero is a real answer — it is what
  // `share: 0` means, and evicting everything is the point.
  if (!Number.isFinite(budget)) {
    return untriggered(budgetLine, bytesBefore);
  }

  // Over budget, and nothing else. A line sitting exactly at its budget is a
  // line doing what it was told, and the acquisition pass fills to the same
  // number — so this is the one condition under which the two can both be
  // satisfied at once.
  if (bytesBefore <= budget) {
    return untriggered(budgetLine, bytesBefore);
  }

  const target = budget;
  // Over-collect: some candidates will be refused, and a pass that collected
  // exactly the shortfall would stop short every time anything was protected.
  const candidates = index.evictionCandidates({
    budgetLineKey: budgetLine.key,
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
    budgetLine,
    triggered: true,
    bytesBefore,
    bytesAfter: held,
    evicted,
    kept,
    shortfall: held > target,
    corruptionSuspected,
    refusal: noProbeRefusal(
      `"${budgetLine.key}"`,
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
  /** Stop pulling other nodes' renditions for this line. */
  "stop-fetching-peer-renditions",
  /** Stop admitting new arrivals that displace already-held bytes. */
  "stop-displacing-held-bytes",
  /** Ask the operator to raise the budget or unpin something. */
  "prompt-raise-budget-or-unpin",
] as const;

export type ShedStep = (typeof SHED_ORDER)[number];

/**
 * How far down the shed order a line has been pushed. `null` means no
 * backpressure: the line is inside its budget and everything runs normally.
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
  readonly budgetLineKey: string;
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
   * Bytes on this line that no reduction can free — pinned, or locally
   * protected.
   *
   * Reported because the two numbers this preview was built from disagree about
   * them: `usageOf` counts pinned bytes toward the line, and
   * `evictionCandidates` excludes them from what may be dropped. Without this
   * figure the preview computed a shortfall it could not name, ran out of
   * candidates before reaching the target, and reported `wouldEvictBytes` short
   * of the gap with `refusal: null` — "confirm and this line will fit", when it
   * will not.
   *
   * This also grows in importance rather than shrinking: `protectedLocally` is
   * hardwired false today and will not stay that way once derivation lands.
   */
  readonly unevictableBytes: number;
  /**
   * True when the line cannot reach `newBudgetBytes` even if the operator
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
 * Compute the impact of lowering a line's budget, without doing anything.
 *
 * Lowering a budget is a destructive action, so it is a two-step: this
 * produces the numbers a confirmation prompt needs ("12,431 originals will be
 * removed; 47 kept because they are not yet confirmed elsewhere"), and only an
 * explicit confirmation runs {@link evictLine}.
 *
 * Note that under shares a budget falls two ways — the namespace's byte count
 * dropping, or a sibling's share rising — and this takes the resulting bytes
 * rather than either cause, so both are previewed by the same call.
 */
export async function previewBudgetReduction(request: {
  readonly budgetLineKey: string;
  readonly newBudgetBytes: number;
  readonly index: ResidentSetIndex;
  readonly probes: readonly ReplicaProbe[];
  readonly durability: DurabilityPolicy;
  readonly contentHashOf: (entry: ResidentEntry) => string | null;
}): Promise<ReductionPreview> {
  const { budgetLineKey, newBudgetBytes, index, probes, durability, contentHashOf } = request;

  const held = index.usageOf(budgetLineKey);
  // Includes pinned and locally protected bytes, which `held` counts and
  // `evictionCandidates` will not offer. The gap between those two facts is what
  // made this preview promise targets it could not reach.
  const unevictableBytes = index.unevictableBytesOf(budgetLineKey);
  if (held <= newBudgetBytes) {
    return {
      budgetLineKey,
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
    budgetLineKey,
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
    `"${budgetLineKey}"`,
    probes,
    keptCount > 0 || unprovable > 0 ? Math.max(keptCount, 1) : 0,
  );

  return {
    budgetLineKey,
    newBudgetBytes,
    wouldEvictCount,
    wouldEvictBytes,
    keptNotConfirmedCount: keptCount,
    keptNotConfirmedBytes: keptBytes,
    unevictableBytes,
    // What is left after everything on offer goes. Pinned and protected bytes
    // stay whatever the operator confirms, so a line whose pins alone exceed
    // the new budget cannot reach it and the prompt has to say so.
    shortfall: held - wouldEvictBytes > newBudgetBytes,
    refusal,
  };
}
