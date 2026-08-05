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
 * - evicted    — row present, blob **held and then dropped**. Wanted again now,
 *                and no sync round will ever bring it back. See below.
 * - resident   — row present, blob present locally.
 * - tombstoned — `deletedAt` is set. Propagates like resident; blob GC is a
 *                separate concern.
 */
export type RecordResidency =
  | "absent"
  | "staged"
  | "elided"
  | "evicted"
  | "resident"
  | "tombstoned";

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
 *
 * ## Why `evicted` is not just a flavour of `staged`
 *
 * `staged` means "still owed", and its durable backstop is the watermark: the
 * peer has not been told we have this, so the next round offers it again. That
 * is exactly what is *not* true of a blob this node held and evicted. Eviction
 * happens well after the record landed, so the watermark moved long ago and the
 * peer considers it delivered — the bytes are as unreachable by sync as an
 * elided one's, and more surprisingly so, because the policy that dropped them
 * will often say `fetch` by the time anyone asks: a pass frees down to the
 * low-water mark, the class is under budget again, and `decide` answers "yes, I
 * want that" for something no round will ever send.
 *
 * That combination — a recoverable state reported for unrecoverable bytes — is
 * what `wasEvicted` exists to break. The route back is `SyncEngine.fetchBlob`,
 * the same one an elided record uses.
 */
export async function residencyOf(
  recordRow: FileRecordRow | null,
  localStorage: ObjectStorageAdapter,
  decide?: (row: FileRecordRow) => Promise<ResidencyDecision> | ResidencyDecision,
  /**
   * Whether this node held these bytes and let them go. Supplied by the host
   * from the resident-set index; absent on a node with no residency manager,
   * where nothing evicts and the question cannot arise.
   */
  wasEvicted?: (objectStorageKey: string) => boolean | Promise<boolean>,
): Promise<RecordResidency> {
  if (!recordRow) return "absent";
  if (recordRow.deleted_at) return "tombstoned";
  const blobHere = await localStorage.has(recordRow.object_storage_key);
  if (blobHere) return "resident";
  // Asked before the policy, because it is a fact rather than an opinion: these
  // bytes were here and are not, and no reading of the current policy changes
  // where they went.
  if (wasEvicted && (await wasEvicted(recordRow.object_storage_key))) return "evicted";
  if (!decide) return "staged";
  return (await decide(recordRow)) === "elide" ? "elided" : "staged";
}
