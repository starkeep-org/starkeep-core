/**
 * The acquisition pass — the queue's one reader.
 *
 * ## What this is for
 *
 * A sync round pulls blobs inline from the metadata walk, and that walk is
 * oldest-first because forward order *is* the coverage claim the watermark
 * makes. On a node whose budget binds, the admission rule then admits nearly
 * every arrival, because on a fresh device every candidate is newer than
 * everything held: the line ends up holding the right bytes, having transferred
 * the whole library to get there. A twenty-year, 400 GB library pulls close to
 * 400 GB to retain 19 GB of it, rewriting a phone's flash in budget-sized
 * increments on the way.
 *
 * The fix is not to walk the change log differently — the protocol needs that
 * order — but to stop pulling once the line is full and let something come back
 * for the rest **in the order the node actually wants them**. That is this
 * pass, and the bound it buys is one budget's worth of wasted transfer per
 * line, once.
 *
 * ## Why the stop condition is one comparison
 *
 * `deferredCandidates` is best-first — the exact reverse of the order the
 * eviction pass gives things up in. So the first candidate the policy declines
 * for want of room is proof that nothing behind it can win either: everything
 * further down the queue ranks worse, and the line just refused something
 * better. The pass stops that line and moves on, which makes an idle tick over
 * a forty-thousand-row queue one query and one decision.
 *
 * That is the same predicate the eviction pass stops on, read from the other
 * end, and it is why the two cannot disagree about what a line should hold.
 *
 * ## Which lines are walked at all
 *
 * Only lines the policy prefetches with a non-zero share. A line the node holds
 * on demand is a cache of what somebody asked for, and speculatively filling it
 * would be exactly the spending `prefetch: false` exists to prevent — most
 * visibly on a phone, where the originals are on-demand precisely so a library
 * is not dragged across the network to be evicted.
 */

import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import { blobCandidateForRecord } from "./sync-engine.js";
import type { ResidencyManager } from "./residency-manager.js";
import type { FileSyncManifest, SyncEngine } from "./types.js";
import {
  budgetBytesFor,
  budgetLineFor,
  budgetLinesOf,
  parseSizeClass,
  retentionRowFor,
  type BudgetLine,
  type NodeRetentionPolicy,
} from "./residency-policy.js";

export interface AcquisitionRequest {
  readonly engine: SyncEngine;
  readonly manager: ResidencyManager;
  readonly databaseAdapter: DatabaseAdapter;
  readonly policy: NodeRetentionPolicy;
  /**
   * Bytes this pass may transfer before it stops.
   *
   * The mirror of `maxBytes` on a sync round, and load-bearing for the same
   * reason: the OS decides when a background job stops, so a unit that cannot
   * finish in its window never finishes at all. The stop condition bounds an
   * *idle* pass to nothing; this bounds a productive one.
   */
  readonly maxBytes: number;
  /** Rows to read per line. Defaults to {@link ACQUISITION_PAGE_ROWS}. */
  readonly pageRows?: number;
}

export interface AcquisitionOutcome {
  readonly budgetLine: BudgetLine;
  readonly landed: number;
  readonly bytesLanded: number;
  /** Queue rows forgotten because the node can never want them. */
  readonly dropped: number;
  /** Transfers that did not happen. The rows stay; the next tick retries. */
  readonly failed: number;
  /**
   * True when the walk ended because the line declined for want of room, i.e.
   * this line has converged and nothing further down the queue can win.
   */
  readonly stoppedAtBudget: boolean;
}

/** A page big enough that a productive pass rarely needs a second query. */
export const ACQUISITION_PAGE_ROWS = 64;

/**
 * Work through every prefetched line's queue, best-first, until the byte budget
 * for this tick runs out.
 *
 * Returns one outcome per line it actually walked. A line with an empty queue
 * produces an outcome with nothing in it rather than being omitted, so a caller
 * logging this can tell "converged" from "never looked at".
 */
export async function runAcquisition(
  request: AcquisitionRequest,
): Promise<AcquisitionOutcome[]> {
  const { engine, manager, databaseAdapter, policy, maxBytes } = request;
  const pageRows = request.pageRows ?? ACQUISITION_PAGE_ROWS;

  const outcomes: AcquisitionOutcome[] = [];
  let bytesThisTick = 0;

  for (const budgetLine of acquirableLines(policy, manager)) {
    if (bytesThisTick >= maxBytes) break;

    let landed = 0;
    let bytesLanded = 0;
    let dropped = 0;
    let failed = 0;
    let stoppedAtBudget = false;

    for (const entry of manager.deferredCandidates(budgetLine.key, pageRows)) {
      if (bytesThisTick >= maxBytes) break;

      // The queue row carries a key and a size; the manifest needs a content
      // hash and a MIME type, which live on the record. One keyed read per
      // candidate the pass actually reaches — and the stop condition is what
      // keeps that number small.
      const record = await databaseAdapter.get(entry.recordId as StarkeepId);
      const candidate = record === null ? null : blobCandidateForRecord(record);
      if (record === null || candidate === null || record.deletedAt) {
        // The record is gone, tombstoned, or no longer carries a blob. Nothing
        // will ever acquire this, and the queue should not keep offering it.
        manager.dropDeferred(entry.objectStorageKey);
        dropped += 1;
        continue;
      }

      const manifest: FileSyncManifest = {
        fileHash: record.contentHash || record.objectStorageKey!,
        objectStorageKey: record.objectStorageKey!,
        sizeBytes: record.sizeBytes,
        ...(record.mimeType ? { mimeType: record.mimeType } : {}),
      };

      const result = await engine.acquireBlob(manifest, candidate);
      if (result.outcome === "landed") {
        // `onLanded` has already made the row resident, which is what takes it
        // out of this queue — there is nothing to clean up here.
        landed += 1;
        bytesLanded += record.sizeBytes;
        bytesThisTick += record.sizeBytes;
        continue;
      }
      if (result.outcome === "failed") {
        // The row stays. This is the retry path a watermark that has already
        // advanced past the record cannot provide, and it is most of why the
        // queue is a better backstop for `staged` than the watermark was.
        failed += 1;
        continue;
      }

      if (result.reason === "budget-exhausted") {
        // Best-first, so nothing behind this can win. One comparison, and the
        // line is done for this tick.
        stoppedAtBudget = true;
        break;
      }
      if (result.reason === "class-disabled" || result.reason === "record-constraint") {
        // Standing refusals: the share went to zero, or the record now forbids
        // these bytes here. Neither will change because the queue waited.
        manager.dropDeferred(entry.objectStorageKey);
        dropped += 1;
        continue;
      }
      // Anything else — `not-prefetched` on a line that has since changed, most
      // likely — leaves the row alone. It costs one decision per tick and the
      // scan is what would have to re-add it, so dropping it would be a quiet
      // way to lose a blob the policy might want again tomorrow.
    }

    outcomes.push({ budgetLine, landed, bytesLanded, dropped, failed, stoppedAtBudget });
  }

  return outcomes;
}

/**
 * The lines worth walking: prefetched, with a share, and known either to the
 * policy or to the index.
 *
 * Both sources, for the reason `runEviction` takes both. The policy alone would
 * miss a line whose rows an operator has since deleted — its bytes are still
 * queued and now pooled into a fallback — and the index alone would stop
 * covering a line the moment its queue emptied and refilled between passes.
 */
function acquirableLines(
  policy: NodeRetentionPolicy,
  manager: ResidencyManager,
): BudgetLine[] {
  const lines = new Map<string, BudgetLine>();
  for (const budgetLine of budgetLinesOf(policy)) lines.set(budgetLine.key, budgetLine);
  for (const sizeClass of Object.keys(manager.usageByClass())) {
    const budgetLine = budgetLineFor(policy, parseSizeClass(sizeClass));
    lines.set(budgetLine.key, budgetLine);
  }

  return [...lines.values()].filter(
    (budgetLine) =>
      retentionRowFor(policy, budgetLine).prefetch &&
      budgetBytesFor(policy, budgetLine) > 0,
  );
}
