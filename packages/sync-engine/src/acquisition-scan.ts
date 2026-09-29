/**
 * The catalogue scan — the acquisition queue's writer.
 *
 * A round decides each blob once, as the change log offers it, and an elided
 * blob advances the watermark. The scan finds every blob this node wants and
 * lacks, whatever the round decided at the time:
 *
 *   1. **stand-ins a raised ceiling now covers,** which rounds declined;
 *   2. **records someone pinned** after their round elided them;
 *   3. **blobs whose bytes went away locally** — on a phone, a camera-roll
 *      asset the person deleted — which no round will resend.
 *
 * It also adopts bytes already here that the index has never seen, such as a
 * local import, so later scans answer from the index.
 *
 * ## Bounded, resumable, and idempotent
 *
 * It walks the catalogue a page at a time and returns its cursor, so a phone
 * that is killed mid-scan resumes rather than restarting. Nothing it writes is
 * a claim about disk — the output is only ever queue rows — so a partial run
 * leaves a smaller queue rather than a wrong one, and a repeated run leaves the
 * same one.
 */

import type { AnyRecord } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import { blobCandidateForRecord } from "./sync-engine.js";
import type { BlobCandidate } from "./residency-policy.js";

/**
 * What the scan does with one record. Supplied by the host, because deciding
 * whether a node wants these bytes needs the node's ceilings and pins.
 *
 * See `ResidencyManager.considerForAcquisition`.
 */
export type AcquisitionCandidateSink = (
  candidate: BlobCandidate,
) => Promise<AcquisitionConsideration> | AcquisitionConsideration;

export type AcquisitionConsideration =
  /** Written to the queue. */
  | "queued"
  /** The bytes are already here. */
  | "held"
  /** This node does not want these bytes — nothing to queue. */
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
 * Normalize a record the same way an inbound round does, so the scan and the
 * round decide the same blob the same way.
 */
function candidateFor(record: AnyRecord): BlobCandidate | null {
  return blobCandidateForRecord(record);
}
