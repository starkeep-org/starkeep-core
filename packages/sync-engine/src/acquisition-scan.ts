/**
 * The catalogue scan — the acquisition queue's second writer, and the one that
 * makes it correct rather than merely fast.
 *
 * ## Why a queue fed only by declined rounds is not enough
 *
 * A round that defers a blob writes down an answer it has just computed, which
 * is cheap and covers the steady state. But it knows nothing about four
 * populations, and they are the ones that matter most on any device that has
 * been running for a while:
 *
 *   1. **the library that landed before this shipped** — the exact population a
 *      cold sync leaves behind, because those rounds elided without deferring;
 *   2. **blobs evicted after their round completed** — the watermark moved long
 *      ago, so no round will offer them again;
 *   3. **blobs whose bytes went away locally** — an evicted rung, or on a phone
 *      a camera-roll asset the user deleted, which reports `staged` today with
 *      no queue, no resident-set row and no route home;
 *   4. **everything newly affordable after a budget is raised**, which nothing
 *      has ever backfilled.
 *
 * This is the only mechanism that finds any of them, and it is one walk for all
 * four. So the scan is the correctness guarantee and the deferred row is an
 * optimisation on top of it — which is what makes deferred rows freely
 * prunable, and a stale queue harmless.
 *
 * ## The filter is structural, not `decide()`
 *
 * A blob that belongs in this queue *is* `budget-exhausted` by construction, so
 * a scan predicated on `decide() === "fetch"` would filter out precisely the
 * population it exists to find. The question asked here is therefore the
 * weaker one — "would this node want these bytes if there were room" — and the
 * real question is asked once per candidate the acquisition pass actually
 * reaches, by `acquireBlob`, against the policy as it stands at that moment.
 *
 * ## Bounded, resumable, and idempotent
 *
 * It walks the catalogue a page at a time and returns its cursor, so a phone
 * that is killed mid-scan resumes rather than restarting. Nothing it writes is
 * a claim about disk — the output is only ever deferred rows — so a partial run
 * leaves a smaller queue rather than a wrong one, and a repeated run leaves the
 * same one.
 */

import type { AnyRecord } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import { blobCandidateForRecord } from "./sync-engine.js";
import type { BlobCandidate } from "./residency-policy.js";

/**
 * What the scan does with one record. Supplied by the host, because deciding
 * whether a node would want these bytes needs the record's labels and the
 * node's policy — neither of which this walk is entitled to know about.
 *
 * See `ResidencyManager.considerForAcquisition`.
 */
export type AcquisitionCandidateSink = (
  candidate: BlobCandidate,
) => Promise<AcquisitionConsideration> | AcquisitionConsideration;

export type AcquisitionConsideration =
  /** Written to the queue. */
  | "queued"
  /** The bytes are already here (or already charged, or already in flight). */
  | "held"
  /** This node does not want this class at all — nothing to queue. */
  | "unwanted";

export interface AcquisitionScanRequest {
  readonly databaseAdapter: DatabaseAdapter;
  readonly consider: AcquisitionCandidateSink;
  /**
   * Where the last run stopped, or null/undefined to start from the beginning.
   *
   * The adapter's own record cursor, so the walk resumes through the same
   * contract every other paged read uses rather than a second position of its
   * own that could disagree with it.
   */
  readonly cursor?: string | null;
  /**
   * How many records to look at before returning.
   *
   * A bound on the *unit*, not on the scan: constraint 2 of the phone's work
   * graph is that no work item may assume more than a few seconds, and a walk
   * over a 60k-item library is not a few seconds. The caller runs another unit
   * from the returned cursor when the OS next lets it.
   */
  readonly maxRecords: number;
  /** Records to read per query. Defaults to {@link SCAN_PAGE_ROWS}. */
  readonly pageRows?: number;
}

export interface AcquisitionScanResult {
  readonly recordsScanned: number;
  readonly queued: number;
  /**
   * Where to resume, or null when the catalogue has been walked to the end.
   *
   * Null is what tells a caller the queue is now complete rather than merely
   * longer — the difference between "this device knows everything it is
   * missing" and "it knows about the first ten thousand".
   */
  readonly nextCursor: string | null;
}

/**
 * A page big enough to amortise the query and small enough that the rows it
 * materialises are kilobytes rather than a library.
 */
export const SCAN_PAGE_ROWS = 200;

export async function scanForAcquirable(
  request: AcquisitionScanRequest,
): Promise<AcquisitionScanResult> {
  const { databaseAdapter, consider, maxRecords } = request;
  const pageRows = request.pageRows ?? SCAN_PAGE_ROWS;

  let cursor: string | null = request.cursor ?? null;
  let recordsScanned = 0;
  let queued = 0;

  while (recordsScanned < maxRecords) {
    const page = await databaseAdapter.query({
      // Tombstones are excluded in the query rather than skipped in the loop so
      // a library that is mostly deletions still makes progress per page. A
      // deleted record's blob is a GC concern; queueing one would have the pass
      // fetch bytes for a record nothing will ever display.
      filters: [{ field: "deletedAt", operator: "isNull" }],
      limit: Math.min(pageRows, maxRecords - recordsScanned),
      ...(cursor ? { cursor } : {}),
    });

    for (const record of page.records) {
      recordsScanned += 1;
      const candidate = candidateFor(record);
      // A record with no blob is not a residency question — app-syncable
      // metadata rows and anything that opted out of file storage reach this
      // walk and have nothing to acquire.
      if (candidate === null) continue;
      if ((await consider(candidate)) === "queued") queued += 1;
    }

    cursor = page.nextCursor;
    if (!page.hasMore || cursor === null) {
      // The end of the catalogue. Reported as a null cursor so the caller can
      // tell a completed sweep from an interrupted one.
      return { recordsScanned, queued, nextCursor: null };
    }
  }

  return { recordsScanned, queued, nextCursor: cursor };
}

/**
 * Normalize a record the same way an inbound round does.
 *
 * Shared with `pullBlob` rather than written again here, because the two must
 * agree about namespace, parentage and origin app: a scan that resolved a
 * rendition's class differently from the round that deferred it would queue the
 * same blob onto a second budget line and the eviction pass would find it on
 * neither.
 */
function candidateFor(record: AnyRecord): BlobCandidate | null {
  return blobCandidateForRecord(record);
}
