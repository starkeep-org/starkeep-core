import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { FileRecordRow } from "./types.js";

/**
 * Per-record state on a single side, derived from facts already on disk.
 * There is intentionally no persisted `sync_status` column; this type names
 * what the combination of (row presence, blob presence, deletedAt) means.
 *
 * See system-design.md "Per-record residency" for the full rationale and how
 * the watermark serves as the durable backstop for the Staged state.
 *
 * - absent     — no row for this id on this side.
 * - staged     — row present, blob required, blob not yet present locally.
 * - resident   — row present, blob present locally.
 * - tombstoned — `deletedAt` is set. Propagates like resident; blob GC is a
 *                separate concern.
 */
export type RecordResidency = "absent" | "staged" | "resident" | "tombstoned";

/**
 * Classify a record's residency on this side. Pass `null` for `recordRow` to
 * model "row not present" (returns `absent`).
 *
 * This is the single canonical derivation. Code and tests should call it
 * rather than reconstructing the predicate from `localStorage.has(key)` etc.
 *
 * Note: rows in `_starkeep_sync_records` always have a blob (the table's
 * purpose). Records that opt out of file storage live in app-syncable
 * metadata tables instead and don't reach this function.
 */
export async function residencyOf(
  recordRow: FileRecordRow | null,
  localStorage: ObjectStorageAdapter,
): Promise<RecordResidency> {
  if (!recordRow) return "absent";
  if (recordRow.deleted_at) return "tombstoned";
  const blobHere = await localStorage.has(recordRow.object_storage_key);
  return blobHere ? "resident" : "staged";
}
