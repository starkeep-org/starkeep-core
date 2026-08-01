import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { FileRecordRow } from "./types.js";
import type { ResidencyDecision } from "./residency-policy.js";

/**
 * Per-record state on a single side, derived from facts already on disk plus
 * the node's current policy. There is intentionally no persisted `sync_status`
 * column; this type names what the combination of (row presence, blob
 * presence, deletedAt, policy) means.
 *
 * See system-design.md "Per-record residency" for the full rationale and how
 * the watermark serves as the durable backstop for the Staged state.
 *
 * - absent     — no row for this id on this side.
 * - staged     — row present, blob wanted, blob not yet present locally.
 * - elided     — row present, blob **deliberately** absent. The node decided it
 *                does not want these bytes; the watermark advances past it.
 * - resident   — row present, blob present locally.
 * - tombstoned — `deletedAt` is set. Propagates like resident; blob GC is a
 *                separate concern.
 */
export type RecordResidency = "absent" | "staged" | "elided" | "resident" | "tombstoned";

/**
 * Classify a record's residency on this side. Pass `null` for `recordRow` to
 * model "row not present" (returns `absent`).
 *
 * This is the single canonical derivation. Code and tests should call it
 * rather than reconstructing the predicate from `localStorage.has(key)` etc.
 *
 * `decide` distinguishes the two ways a blob can be missing. Without it every
 * blobless row reads as `staged`, i.e. "still owed", which is exactly the
 * conflation that made `Elided` impossible before. It is **re-evaluated**
 * rather than stored, matching the sync engine's no-persisted-status design:
 * elided-ness is a function of current policy, so raising a budget makes a
 * record staged again on its own, with no migration and no stale flag. The
 * cost of that choice is that the watermark has already moved past the record,
 * so the re-fetch will not arrive through a sync round — it needs an explicit
 * fetch (see `FileSyncEngine.fetchBlobOnDemand`).
 *
 * Note: rows in `_starkeep_sync_records` always have a blob (the table's
 * purpose). Records that opt out of file storage live in app-syncable
 * metadata tables instead and don't reach this function.
 */
export async function residencyOf(
  recordRow: FileRecordRow | null,
  localStorage: ObjectStorageAdapter,
  decide?: (row: FileRecordRow) => Promise<ResidencyDecision> | ResidencyDecision,
): Promise<RecordResidency> {
  if (!recordRow) return "absent";
  if (recordRow.deleted_at) return "tombstoned";
  const blobHere = await localStorage.has(recordRow.object_storage_key);
  if (blobHere) return "resident";
  if (!decide) return "staged";
  return (await decide(recordRow)) === "elide" ? "elided" : "staged";
}
