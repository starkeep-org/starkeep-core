import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { FileRecordRow } from "./types.js";
import type { ResidencyVerdict } from "./residency-policy.js";

/**
 * Per-record state on a single side, derived from facts already on disk plus
 * the node's current policy. There is intentionally no persisted `sync_status`
 * column; this type names what the combination of (row presence, blob
 * presence, deletedAt, policy) means.
 *
 * See system-design.md "Per-record residency" for the full rationale.
 *
 * - absent     — no row for this id on this side.
 * - staged     — row present, blob **wanted**, blob not yet present locally.
 * - elided     — row present, blob **deliberately** absent. The node decided it
 *                does not want these bytes; the watermark advances past it.
 * - evicted    — row present, blob **held and then removed** by "Free up
 *                space". No sync round will ever bring it back. See below.
 * - resident   — row present, blob present locally.
 * - tombstoned — `deletedAt` is set. Propagates like resident; blob GC is a
 *                separate concern.
 *
 * ## Why the reason rides out alongside the state
 *
 * "Arriving" and "above this node's ceiling" read differently to a person, and
 * the verdict already computes which one applies.
 */
export type RecordResidency =
  | "absent"
  | "staged"
  | "elided"
  | "evicted"
  | "resident"
  | "tombstoned";

/**
 * A residency answer: the state, and why the policy came out that way.
 *
 * `reason` is null wherever no policy was consulted — an absent row, a
 * tombstone, bytes that are simply here, or a caller that passed no decider.
 */
export interface RecordResidencyState {
  readonly state: RecordResidency;
  readonly reason: ResidencyVerdict["reason"] | null;
}

/**
 * Classify a record's residency on this side. Pass `null` for `recordRow` to
 * model "row not present" (returns `absent`).
 *
 * This is the single canonical derivation. Code and tests should call it
 * rather than reconstructing the predicate from `localStorage.has(key)` etc.
 *
 * `decide` distinguishes the ways a blob can be missing. Without it every
 * blobless row reads as `staged`, i.e. "still owed". It is **re-evaluated**
 * rather than stored, matching the sync engine's no-persisted-status design:
 * elided-ness is a function of the node's current ceiling, so raising
 * a ceiling makes a record staged again on its own, with no migration and no
 * stale flag.
 *
 * Note: rows in `_starkeep_sync_records` always have a blob (the table's
 * purpose). Records that opt out of file storage live in app-syncable
 * metadata tables instead and don't reach this function.
 *
 * ## Why `evicted` is not just a flavour of `staged`
 *
 * `staged` means "still owed", and a sync round is what settles it. That is
 * exactly what is *not* true of a blob this node held and let go through "Free
 * up space": the watermark moved long ago and the peer considers it delivered,
 * so no round will bring the bytes back. The routes back are
 * `SyncEngine.fetchBlob` and the acquisition pass, and neither is a *round*,
 * which is what `staged` promises.
 */
export async function residencyOf(
  recordRow: FileRecordRow | null,
  localStorage: ObjectStorageAdapter,
  decide?: (row: FileRecordRow) => Promise<ResidencyVerdict> | ResidencyVerdict,
  /**
   * Whether this node held these bytes and let them go. Supplied by the host
   * from the resident-set index; absent on a node with no residency manager,
   * where nothing is ever removed and the question cannot arise.
   */
  wasEvicted?: (objectStorageKey: string) => boolean | Promise<boolean>,
): Promise<RecordResidencyState> {
  if (!recordRow) return { state: "absent", reason: null };
  if (recordRow.deleted_at) return { state: "tombstoned", reason: null };
  const blobHere = await localStorage.has(recordRow.object_storage_key);
  if (blobHere) return { state: "resident", reason: null };
  // Asked before the policy, because it is a fact rather than an opinion: these
  // bytes were here and are not, and no reading of the current policy changes
  // where they went.
  if (wasEvicted && (await wasEvicted(recordRow.object_storage_key))) {
    return { state: "evicted", reason: null };
  }
  if (!decide) return { state: "staged", reason: null };
  const verdict = await decide(recordRow);
  return {
    state: verdict.decision === "fetch" ? "staged" : "elided",
    reason: verdict.reason,
  };
}
