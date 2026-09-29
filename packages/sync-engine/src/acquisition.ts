/**
 * The acquisition pass — the queue's one reader.
 *
 * A sync round decides each blob as the change log offers it, and an elided
 * blob advances the watermark, so no round offers it again. Some of those
 * blobs become wanted later: the person raises this node's ceiling, turns on
 * "Keep originals here", or the bytes go missing locally. The catalogue scan writes those
 * down (`scanForAcquirable`), and this pass fetches them, oldest first, until
 * the tick's byte cap runs out.
 *
 * Each candidate is decided again before a byte moves, so a queue row that has
 * gone stale — a lowered ceiling, a removed pin — costs one decision and is
 * dropped.
 */

import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { StarkeepId } from "@starkeep/protocol-primitives";
import { blobCandidateForRecord } from "./sync-engine.js";
import type { ResidencyManager } from "./residency-manager.js";
import type { FileSyncManifest, SyncEngine } from "./types.js";

export interface AcquisitionRequest {
  readonly engine: SyncEngine;
  readonly manager: ResidencyManager;
  readonly databaseAdapter: DatabaseAdapter;
  /**
   * Bytes this pass may transfer before it stops.
   *
   * The mirror of `maxBytes` on a sync round: the OS decides when a background
   * job stops, so a unit that cannot finish in its window never finishes at
   * all.
   */
  readonly maxBytes: number;
  /** Queue rows to read. Defaults to {@link ACQUISITION_PAGE_ROWS}. */
  readonly pageRows?: number;
}

export interface AcquisitionOutcome {
  readonly landed: number;
  readonly bytesLanded: number;
  /** Queue rows forgotten because the node no longer wants them. */
  readonly dropped: number;
  /** Transfers that did not happen. The rows stay; the next pass retries. */
  readonly failed: number;
}

/** One page of the queue per pass. */
export const ACQUISITION_PAGE_ROWS = 64;

/**
 * Work through one page of the queue, oldest first, until the byte cap for
 * this pass runs out. A caller that wants the whole queue calls again while
 * the pass keeps landing blobs.
 */
export async function runAcquisition(request: AcquisitionRequest): Promise<AcquisitionOutcome> {
  const { engine, manager, databaseAdapter, maxBytes } = request;
  const pageRows = request.pageRows ?? ACQUISITION_PAGE_ROWS;

  let landed = 0;
  let bytesLanded = 0;
  let dropped = 0;
  let failed = 0;

  for (const entry of manager.deferredCandidates(pageRows)) {
    if (bytesLanded >= maxBytes) break;

    // The queue row carries a key and a size; the manifest needs a content
    // hash and a MIME type, which live on the record.
    const record = await databaseAdapter.get(entry.recordId as StarkeepId);
    const candidate = record === null ? null : blobCandidateForRecord(record);
    if (record === null || candidate === null || record.deletedAt) {
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
      // `onLanded` has already made the row resident, which takes it out of
      // the queue.
      landed += 1;
      bytesLanded += record.sizeBytes;
    } else if (result.outcome === "declined") {
      manager.dropDeferred(entry.objectStorageKey);
      dropped += 1;
    } else {
      failed += 1;
    }
  }

  return { landed, bytesLanded, dropped, failed };
}
