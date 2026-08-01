/**
 * The reconcile: a periodic sweep that corrects availability when events were
 * never delivered.
 *
 * Event delivery is at-least-once, not exactly-once, and this system
 * deliberately swallows a malformed notification rather than letting S3
 * redeliver a batch forever. Both choices are right, and both mean something
 * can be lost — so without a backstop a record can stay wrong indefinitely,
 * and the wrongness is invisible until somebody tries to read it.
 *
 * ## What an inventory can and cannot see
 *
 * S3 Inventory reports storage class and Intelligent-Tiering access tier. It
 * does **not** report restore status: there is no field for "a thaw is in
 * flight" or "a restored copy exists until Friday". So the sweep splits in two:
 *
 *   - Everything an inventory *can* settle — archived vs readable — is settled
 *     from the report alone, at no per-object request cost. That is the whole
 *     reason inventory exists rather than a HeadObject per record.
 *   - Restore state is settled by probing, but only for the records that claim
 *     to be mid-restore and whose estimated ready time has passed. That set is
 *     bounded by how many restores are actually outstanding, not by library
 *     size, which is what keeps the backstop affordable.
 *
 * ## Why the report is not simply trusted wholesale
 *
 * An inventory is a *snapshot*, generated hours before it is read. A transition
 * that happened after the snapshot would be overwritten by it if the report
 * were applied blindly — so every observation carries the snapshot's own time
 * and the same newer-wins rule the event path uses decides.
 */

import type { AvailabilityObservation } from "./availability-events.js";
import { expectedLatencyHoursFor, isArchivedClass, shouldReplace } from "./availability-events.js";

/** One row of an S3 Inventory report, reduced to the fields that matter here. */
export interface InventoryRow {
  readonly objectStorageKey: string;
  /** e.g. "INTELLIGENT_TIERING", "DEEP_ARCHIVE". */
  readonly storageClass: string;
  /**
   * Intelligent-Tiering's access tier, when the object is in I-T.
   *
   * This is the field that distinguishes a cheap-but-readable I-T object from
   * one that has sunk into an asynchronous archive tier. Reading storage class
   * alone would call the second one readable, which is exactly the confusion
   * `stat()` was widened to avoid.
   */
  readonly intelligentTieringAccessTier?: string;
}

/** What the caller already believes about a key. */
export interface StoredAvailabilityLike {
  readonly objectStorageKey: string;
  readonly state: "instant" | "restoring" | "archived" | "absent";
  readonly readyAtMs: number | null;
  readonly restoredUntilMs: number | null;
  readonly observedAtMs: number;
}

export interface ReconcileResult {
  /** Observations to persist. Only keys whose state actually changed. */
  readonly observations: readonly AvailabilityObservation[];
  /**
   * Keys the inventory did not mention but which we hold a row for. The object
   * is gone; the row is stale.
   */
  readonly vanished: readonly string[];
  /**
   * Keys claiming to be mid-restore whose estimated ready time has passed.
   *
   * An inventory cannot see restore state, so these need a per-object probe.
   * The set is bounded by outstanding restores rather than by library size,
   * which is what makes probing them affordable — and it is the only way a
   * record whose `ObjectRestore:Completed` event was lost ever gets unstuck.
   */
  readonly needsRestoreProbe: readonly string[];
  /**
   * Keys that are archived but were expected to be instantly readable.
   *
   * Reported rather than corrected, because the fix is not a database write —
   * something archived an object that should never have been archivable, and
   * the interesting question is what. A rendition in Deep Archive means the
   * lifecycle rule matched something it should not, which is a bug that will
   * repeat until someone looks.
   */
  readonly unexpectedlyArchived: readonly string[];
}

export interface ReconcileInput {
  readonly rows: readonly InventoryRow[];
  /** Current stored rows, keyed by object key. */
  readonly stored: ReadonlyMap<string, StoredAvailabilityLike>;
  /** When the inventory snapshot was taken — **not** when it was read. */
  readonly snapshotAtMs: number;
  readonly nowMs: number;
  /**
   * True for keys that must never be archived — renditions, in practice.
   *
   * Supplied by the caller because the platform does not know what a rendition
   * is. Defaults to "no expectation", which reports nothing rather than
   * guessing.
   */
  readonly expectedInstant?: (objectStorageKey: string) => boolean;
}

export function reconcileAvailability(input: ReconcileInput): ReconcileResult {
  const observations: AvailabilityObservation[] = [];
  const unexpectedlyArchived: string[] = [];
  const seen = new Set<string>();

  for (const row of input.rows) {
    seen.add(row.objectStorageKey);

    // I-T's access tier overrides the storage class: an object in
    // INTELLIGENT_TIERING whose access tier is DEEP_ARCHIVE_ACCESS exists and
    // cannot be read, and the storage class alone says nothing about that.
    const effectiveClass =
      row.intelligentTieringAccessTier && isArchivedClass(row.intelligentTieringAccessTier)
        ? row.intelligentTieringAccessTier
        : row.storageClass;
    const archived = isArchivedClass(effectiveClass);

    if (archived && input.expectedInstant?.(row.objectStorageKey)) {
      unexpectedlyArchived.push(row.objectStorageKey);
    }

    const stored = input.stored.get(row.objectStorageKey) ?? null;

    // A restored copy that has not lapsed is readable even though the object's
    // storage class is archived. The inventory cannot see that, so a stored
    // `restoredUntilMs` still in the future is believed over the report.
    if (
      archived &&
      stored?.restoredUntilMs !== null &&
      stored?.restoredUntilMs !== undefined &&
      stored.restoredUntilMs > input.nowMs
    ) {
      continue;
    }

    const observation: AvailabilityObservation = archived
      ? {
          objectStorageKey: row.objectStorageKey,
          state: "archived",
          tier: effectiveClass,
          expectedLatencyHours: expectedLatencyHoursFor(effectiveClass),
          readyAtMs: null,
          restoredUntilMs: null,
          observedAtMs: input.snapshotAtMs,
        }
      : {
          objectStorageKey: row.objectStorageKey,
          state: "instant",
          tier: effectiveClass,
          expectedLatencyHours: null,
          readyAtMs: null,
          restoredUntilMs: null,
          observedAtMs: input.snapshotAtMs,
        };

    // A snapshot taken hours ago must not overwrite an event that happened
    // since. Same newer-wins rule as the event path, for the same reason.
    if (!shouldReplace(stored, observation)) continue;
    // No row and already instant is the default — writing it would be churn.
    if (!stored && observation.state === "instant") continue;
    if (stored && stored.state === observation.state) continue;

    observations.push(observation);
  }

  const vanished: string[] = [];
  const needsRestoreProbe: string[] = [];
  for (const [key, stored] of input.stored) {
    if (stored.state === "restoring") {
      // An inventory cannot confirm a restore either way, so a `restoring` row
      // is never marked vanished on its absence — but one whose estimate has
      // elapsed is exactly the case a lost completion event produces, and it
      // stays stuck forever unless something probes it.
      if (stored.readyAtMs !== null && stored.readyAtMs <= input.nowMs) {
        needsRestoreProbe.push(key);
      }
      continue;
    }
    if (!seen.has(key) && stored.state !== "absent") {
      vanished.push(key);
    }
  }

  return { observations, vanished, needsRestoreProbe, unexpectedlyArchived };
}

/** The observation to write for a key the inventory no longer lists. */
export function vanishedObservation(
  objectStorageKey: string,
  snapshotAtMs: number,
): AvailabilityObservation {
  return {
    objectStorageKey,
    state: "absent",
    tier: null,
    expectedLatencyHours: null,
    readyAtMs: null,
    restoredUntilMs: null,
    observedAtMs: snapshotAtMs,
  };
}
