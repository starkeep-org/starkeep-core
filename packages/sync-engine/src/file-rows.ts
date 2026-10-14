/**
 * Rows that may name a file, and the bytes watermark over them.
 *
 * A **bytes watermark** says, per author, "every file this node wants, from
 * rows by that author up to here, is in this node's storage". It sits beside
 * the rows watermark rather than inside it, so a row can land and show before
 * its file arrives. Both halves of the protocol keep one: the requester for its
 * own downloads, and the responder for what it reports back so the requester
 * knows which uploads it still owes. See
 * `SyncExchangeResponse.responderByteWatermarks`.
 *
 * This module holds the parts both halves share: which rows can name a file,
 * how to scan them above a watermark, and how a watermark advances over the
 * result.
 */

import { compareHLC, type AnyRecord, type HLCTimestamp, type StarkeepId } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import type { BlobCandidate } from "./residency-policy.js";
import { computeCeilings, type StreamTruncation } from "./round-cut.js";
import type { AppSyncableRowEntry, FileSyncManifest, ScanSincePage, Watermarks } from "./types.js";

// Mirror of `FILE_RECORDS_TABLE` from `@starkeep/shared-space-api`. The sync
// engine cannot import that package (cycle), but it needs the table name to
// recognize which app-syncable rows carry blobs. Keep these in sync.
export const FILE_RECORDS_TABLE = "_starkeep_sync_records";

/** Label namespace for platform-level record constraints. */
export const STARKEEP_LABEL_APP_ID = "starkeep";
/** Record label forbidding these bytes from reaching cloud storage. */
export const NO_CLOUD_LABEL_KEY = "no-cloud";

/**
 * The records among `recordIds` marked `starkeep/no-cloud`.
 *
 * Read in one batch. Only the platform's own namespace counts: an app writing
 * the same key into its namespace is annotating, not constraining.
 */
export async function cloudExcludedRecords(
  db: DatabaseAdapter,
  recordIds: readonly StarkeepId[],
): Promise<ReadonlySet<StarkeepId>> {
  const out = new Set<StarkeepId>();
  if (recordIds.length === 0) return out;
  const labels = await db.getLabelsByRecordIds([...recordIds]);
  for (const [recordId, list] of labels) {
    if (
      list.some(
        (label) =>
          !label.deletedAt &&
          label.appId === STARKEEP_LABEL_APP_ID &&
          label.key === NO_CLOUD_LABEL_KEY,
      )
    ) {
      out.add(recordId);
    }
  }
  return out;
}

/** One row that may name a file, in the shape both transfer passes read. */
export interface FileRow {
  readonly hlc: HLCTimestamp;
  /** Null for a row with no file: a tombstone, or a row naming no key. */
  readonly manifest: FileSyncManifest | null;
  readonly candidate: BlobCandidate | null;
  /** The record to announce when the bytes land; null for an app row. */
  readonly recordId: StarkeepId | null;
  /** What a log line names the row by. */
  readonly itemId: string;
}

export interface FileRowScan {
  readonly rows: FileRow[];
  /**
   * Per author, how far every scanned stream enumerated — see
   * `computeCeilings`. A watermark may not pass an author's ceiling, because
   * rows above it were not read.
   */
  readonly ceilings: Map<string, HLCTimestamp | null>;
  /** False when a stream would not read; the scan is then empty. */
  readonly readable: boolean;
}

/** Where a channel's file-bearing rows live, in the shape either side holds. */
export interface FileRowSources {
  /** The Drive channel's shared records, or null on a per-app channel. */
  readonly records: DatabaseAdapter | null;
  /**
   * Scans one app's reserved file table, for each app on the channel whose
   * namespace has one. Empty on the Drive channel.
   */
  readonly fileTables: ReadonlyArray<{
    readonly appId: string;
    scanSince(watermarks: Watermarks, limit: number): Promise<ScanSincePage>;
  }>;
}

/** Whether a channel can carry files at all. */
export function carriesFiles(sources: FileRowSources): boolean {
  return sources.records !== null || sources.fileTables.length > 0;
}

/**
 * Every row above `from` that may name a file, with each stream's ceilings.
 *
 * Labels and plain app tables are left out: they never name a file, so they
 * cannot hold a bytes watermark back, and a ceiling from a stream that was not
 * needed would only shorten the window.
 */
export async function scanFileRows(
  sources: FileRowSources,
  from: Watermarks,
  limit: number,
): Promise<FileRowScan> {
  const rows: FileRow[] = [];
  const truncations: StreamTruncation[] = [];
  try {
    if (sources.records) {
      const page = await sources.records.querySince(from, limit);
      truncations.push(page.truncated);
      for (const record of page.rows) {
        rows.push({
          hlc: record.updatedAt,
          manifest: manifestForRecord(record),
          candidate: blobCandidateForRecord(record),
          recordId: record.id,
          itemId: record.id,
        });
      }
    }
    for (const table of sources.fileTables) {
      const page = await table.scanSince(from, limit);
      truncations.push(page.truncated);
      for (const entry of page.rows) {
        rows.push({
          hlc: entry.timestamp,
          manifest: manifestForAppRow(entry),
          candidate: candidateForAppRow(entry),
          recordId: null,
          itemId: `${entry.appId}.${entry.table}`,
        });
      }
    }
  } catch (err) {
    // A stream that would not read might hold the oldest owed file of any
    // author, so nothing may advance past it. An empty scan advances nothing.
    console.warn(`[sync] file-row scan failed: ${(err as Error).message}`);
    return { rows: [], ceilings: new Map(), readable: false };
  }
  return { rows, ceilings: computeCeilings(truncations), readable: true };
}

/**
 * Raise a bytes watermark over a contiguous run of satisfied rows.
 *
 * Per author, in timestamp order: advance past each **whole timestamp** whose
 * rows are all satisfied, and stop at the first one that is not, or at the
 * author's ceiling. Whole timestamps because the next scan asks for rows
 * strictly above the watermark, so advancing to a timestamp that one of its
 * rows has not met would skip that row forever. See `round-cut.ts`, "One HLC
 * is indivisible".
 *
 * Never lowers a value. Lowering is the caller's decision, made before the
 * scan: the responder clamps its stored value to its rows watermark after a
 * loss.
 */
export function advanceBytesWatermark(
  from: Watermarks,
  rows: ReadonlyArray<{ readonly hlc: HLCTimestamp; readonly satisfied: boolean }>,
  ceilings: ReadonlyMap<string, HLCTimestamp | null>,
): Watermarks {
  const next: Watermarks = { ...from };
  const byAuthor = new Map<string, { hlc: HLCTimestamp; satisfied: boolean }[]>();
  for (const row of rows) {
    const run = byAuthor.get(row.hlc.nodeId) ?? [];
    run.push(row);
    byAuthor.set(row.hlc.nodeId, run);
  }
  for (const [author, run] of byAuthor) {
    const hasCeiling = ceilings.has(author);
    const ceiling = ceilings.get(author) ?? null;
    if (hasCeiling && ceiling === null) continue;
    run.sort((a, b) => compareHLC(a.hlc, b.hlc));
    for (let start = 0; start < run.length; ) {
      let end = start + 1;
      while (end < run.length && compareHLC(run[start]!.hlc, run[end]!.hlc) === 0) end += 1;
      const hlc = run[start]!.hlc;
      if (hasCeiling && compareHLC(hlc, ceiling!) > 0) break;
      if (!run.slice(start, end).every((row) => row.satisfied)) break;
      const prior = next[author];
      if (prior === undefined || compareHLC(hlc, prior) > 0) next[author] = hlc;
      start = end;
    }
  }
  return next;
}

/**
 * Per author, the lower of a stored bytes watermark and the rows watermark.
 *
 * A bytes watermark above the rows a node holds would claim files for rows it
 * no longer has. After a loss the rows watermark falls, the peer re-ships the
 * rows, and the files under them have to be checked again.
 */
export function clampToRows(bytes: Watermarks, rows: Watermarks): Watermarks {
  const out: Watermarks = {};
  for (const [author, hlc] of Object.entries(bytes)) {
    const ceiling = rows[author];
    if (ceiling === undefined) continue;
    out[author] = compareHLC(hlc, ceiling) <= 0 ? hlc : ceiling;
  }
  return out;
}

/**
 * Normalize a shared record into the shape the residency decision reads.
 */
export function blobCandidateForRecord(record: AnyRecord): BlobCandidate | null {
  if (!record.objectStorageKey) return null;
  return {
    recordId: record.id,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    type: record.type,
    parentId: record.parentId,
    appId: null,
    // Columns, so the ceiling decision needs no second read — see
    // `ceilingPlacement` in protocol-primitives.
    standInRole: record.standInRole ?? null,
    fidelity: record.fidelity ?? null,
    canonicalThreshold: record.canonicalThreshold ?? null,
    selfCanonical: record.selfCanonical ?? false,
  };
}

/** Same, for a row in the reserved `_starkeep_sync_records` table. */
export function candidateForAppRow(entry: AppSyncableRowEntry): BlobCandidate | null {
  if (entry.table !== FILE_RECORDS_TABLE || entry.op === "delete") return null;
  const row = entry.row;
  if (!row) return null;
  const key = row["object_storage_key"];
  if (typeof key !== "string" || key.length === 0) return null;
  const sizeBytes = row["size_bytes"];
  const id = row["id"];
  return {
    recordId: typeof id === "string" ? id : key,
    objectStorageKey: key,
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : Number(sizeBytes) || 0,
    type: null,
    parentId: null,
    appId: entry.appId,
  };
}

export function manifestForRecord(record: AnyRecord): FileSyncManifest | null {
  if (!record.objectStorageKey || record.deletedAt) return null;
  return {
    fileHash: record.contentHash || record.objectStorageKey,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    mimeType: record.mimeType ?? undefined,
  };
}

/**
 * Derive a blob manifest from an app-syncable row entry. Only the reserved
 * `_starkeep_sync_records` table carries blobs at the protocol level; plain
 * app-row tables (AW) never do. Tombstones return null — blob retention on
 * delete is a GC concern, not a sync concern.
 */
export function manifestForAppRow(entry: AppSyncableRowEntry): FileSyncManifest | null {
  if (entry.table !== FILE_RECORDS_TABLE) return null;
  if (entry.op === "delete") return null;
  const row = entry.row;
  if (!row) return null;
  const key = row["object_storage_key"];
  if (typeof key !== "string" || key.length === 0) return null;
  const contentHash = row["content_hash"];
  const mimeType = row["mime_type"];
  const sizeBytes = row["size_bytes"];
  return {
    fileHash:
      typeof contentHash === "string" && contentHash.length > 0
        ? contentHash
        : key,
    objectStorageKey: key,
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : Number(sizeBytes) || 0,
    mimeType: typeof mimeType === "string" ? mimeType : undefined,
  };
}
