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
 * - evicted    — row present, blob **held and then dropped**. Wanted again now,
 *                and no sync round will ever bring it back. See below.
 * - resident   — row present, blob present locally.
 * - tombstoned — `deletedAt` is set. Propagates like resident; blob GC is a
 *                separate concern.
 *
 * ## `elided` means unwanted; `staged` means wanted and not here yet
 *
 * `elided` used to cover two facts that behave completely differently. Three of
 * its reasons — `class-disabled`, `not-prefetched`, `record-constraint` — are
 * *standing statements about the node*: this device does not want this class,
 * and will not want it until somebody changes the policy. The fourth,
 * `budget-exhausted`, is **contention**: the node wants these bytes and the line
 * was full at the moment it was asked, which flips the instant anything is
 * evicted or opened or a budget moves.
 *
 * Since the acquisition queue exists, `budget-exhausted` reads as `staged`, and
 * that is not a softening of the vocabulary — it is `elided`'s own definition
 * ("the node **decided it does not want** these bytes") being simply false of
 * it. A budget-deferred blob is owed, something is going to fetch it, and
 * reporting it as declined told a UI to stop waiting.
 *
 * ## `staged`'s two backstops
 *
 * What actually changes for `staged` is only what will eventually make it
 * `resident`:
 *
 *   - **the watermark**, for a blob an in-flight round is bringing. The peer has
 *     not been told we have this, so the next round offers it again.
 *   - **the acquisition queue**, for a blob a round deferred. This is the better
 *     of the two, because it survives an advanced watermark — which the
 *     watermark, by construction, cannot.
 *
 * ## Why the reason rides out alongside the state
 *
 * "Arriving" and "queued behind forty thousand others" are the same state and
 * very different sentences, and the alternative to carrying the reason was a
 * sixth state that means "staged, but slowly". The verdict already computes it;
 * this function used to narrow it away one line before anyone could read it.
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
 * blobless row reads as `staged`, i.e. "still owed", which is exactly the
 * conflation that made `Elided` impossible before. It is **re-evaluated**
 * rather than stored, matching the sync engine's no-persisted-status design:
 * elided-ness is a function of current policy, so raising a budget makes a
 * record staged again on its own, with no migration and no stale flag.
 *
 * Note: rows in `_starkeep_sync_records` always have a blob (the table's
 * purpose). Records that opt out of file storage live in app-syncable
 * metadata tables instead and don't reach this function.
 *
 * ## Why `evicted` is not just a flavour of `staged`
 *
 * `staged` means "still owed", and a sync round is what settles it. That is
 * exactly what is *not* true of a blob this node held and evicted: eviction
 * happens well after the record landed, so the watermark moved long ago and the
 * peer considers it delivered — the bytes are as unreachable by a round as an
 * elided one's, and more surprisingly so, because the policy that dropped them
 * will often say `fetch` by the time anyone asks. A pass frees the class back
 * to its budget, there is room again, and `decide` answers "yes, I want that"
 * for something no round will ever send.
 *
 * That combination — a recoverable state reported for unrecoverable bytes — is
 * what `wasEvicted` exists to break. The routes back are `SyncEngine.fetchBlob`,
 * the same one an elided record uses, and the acquisition pass, which finds
 * departed rows in the catalogue scan. `evicted` stays its own state because
 * neither of those is a *round*, which is what `staged` promises.
 */
export async function residencyOf(
  recordRow: FileRecordRow | null,
  localStorage: ObjectStorageAdapter,
  decide?: (row: FileRecordRow) => Promise<ResidencyVerdict> | ResidencyVerdict,
  /**
   * Whether this node held these bytes and let them go. Supplied by the host
   * from the resident-set index; absent on a node with no residency manager,
   * where nothing evicts and the question cannot arise.
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
  if (verdict.decision === "fetch") return { state: "staged", reason: verdict.reason };
  // The one elide reason that is contention rather than a refusal. Something is
  // going to come back for these bytes — the acquisition queue, not a round —
  // so reporting them declined would tell a UI to stop waiting for a blob that
  // is genuinely owed.
  return {
    state: verdict.reason === "budget-exhausted" ? "staged" : "elided",
    reason: verdict.reason,
  };
}
