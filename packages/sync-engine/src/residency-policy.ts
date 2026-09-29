/**
 * Residency policy — the decision a node makes *before* a blob transfer about
 * whether it wants these bytes at all.
 *
 * The problem this solves is stated in the media plan §6.1: a missing blob used
 * to be a *failure*, so the sync engine held the watermark back and the record
 * was re-shipped forever. There was no way for a node to say "I have the
 * metadata and I am intentionally not fetching the bytes."
 *
 * So: `decideResidency` runs before the pull. `"elide"` applies the metadata,
 * skips the blob, and **advances the watermark** — a declined blob is a
 * legitimate terminal state, not a retry. `"fetch"` that then fails is
 * unchanged: the watermark holds and the next round retries.
 *
 * ## What a node may go without
 *
 * Only a file a stand-in can replace, and only above the node's sync-down
 * ceiling. Everything else — a document, a poster frame, an app's private
 * file — arrives on every node and stays there. There is no budget and no
 * automatic eviction: the person's "Free up space" is the one path that
 * removes a file, and it only removes what a stand-in can replace.
 *
 * The host resolves where a file sits against the ceiling (`ceilingPlacement`
 * in protocol-primitives); this module only orders that answer against the
 * record's constraints and the node's pins.
 */

import type { CeilingPlacement, StandInRole } from "@starkeep/protocol-primitives";

/**
 * Constraints carried *on the record*, honoured identically by every node.
 * This is the restrictive tier: nothing below may override it.
 */
export interface RecordConstraints {
  /**
   * The record's own constraints forbid these bytes being held *on this node*.
   *
   * Phrased about this node rather than naming a specific rule, because the
   * rules are not symmetric: `starkeep/no-cloud` forbids the cloud node and
   * says nothing about a laptop. The host computes this, because only it knows
   * which node it is. And because a fetch-time decision cannot stop an inbound
   * *push*, any constraint that must actually hold also needs a server-side
   * refusal.
   */
  readonly deniedHere: boolean;
}

/** Node-local per-record state. Travels with nothing. */
export interface LocalOverrides {
  /**
   * This node keeps these bytes: it fetches them even above its ceiling, and
   * "Free up space" skips them.
   */
  readonly pinned: boolean;
}

/** Normalized view of the thing whose blob is about to move. */
export interface BlobCandidate {
  readonly recordId: string;
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
  /** Canonical Starkeep type, or null for app-syncable rows. */
  readonly type: string | null;
  readonly parentId: string | null;
  /** Owning app for an app-syncable row; null for shared records. */
  readonly appId: string | null;
  /**
   * The shared record's stand-in role, when it is a stand-in. Absent or null
   * on app-syncable rows and on every other record.
   */
  readonly standInRole?: StandInRole | null;
  /** The record's reported fidelity; see `DataRecord.fidelity`. */
  readonly fidelity?: number | null;
}

export type ResidencyDecision = "fetch" | "elide";

/** Why a decision came out the way it did — for the residency inspector. */
export interface ResidencyVerdict {
  readonly decision: ResidencyDecision;
  /**
   * Whether this node pins the record. Optional because
   * `SyncEngine.fetchBlob` synthesizes a verdict it never asked the policy for.
   */
  readonly pinned?: boolean;
  readonly reason:
    | "record-constraint"
    | "pinned"
    // No stand-in can replace this file, so every node keeps it.
    | "kept"
    // A stand-in, or a self-canonical original, at or below the node's
    // sync-down ceiling: received by default, never removed.
    | "within-ceiling"
    // Above the ceiling — an archivable original, a canonical stand-in, a
    // file whose fidelity nobody reported. Received only when asked for,
    // through `SyncEngine.fetchBlob`.
    | "above-ceiling"
    // Not a decision this module made. `SyncEngine.fetchBlob` answers a direct
    // request and is deliberately not subject to the policy, but the arrival
    // is still recorded — so it reports a verdict it did not ask for, named so
    // the residency inspector does not read it as one.
    | "explicit-request";
}

export interface DecideResidencyInputs {
  readonly constraints: RecordConstraints;
  readonly overrides: LocalOverrides;
  /** Where the candidate sits against this node's ceiling, resolved by the host. */
  readonly placement: CeilingPlacement;
}

/**
 * The background decision — a sync round, or the acquisition pass working its
 * queue — in a fixed order. A direct request never comes here:
 * `SyncEngine.fetchBlob` fetches whatever it is asked for.
 *
 * The order matters because two of the inputs
 * pull in opposite directions: a record constraint says "nobody may hold this
 * here" and a pin says "this node insists on holding it". Restrictive wins,
 * and it wins first.
 */
export function decideResidency(inputs: DecideResidencyInputs): ResidencyVerdict {
  const { constraints, overrides, placement } = inputs;
  const pinned = overrides.pinned;

  if (constraints.deniedHere) {
    return { decision: "elide", reason: "record-constraint", pinned };
  }
  if (pinned) {
    return { decision: "fetch", reason: "pinned", pinned };
  }
  if (placement === "above") {
    return { decision: "elide", reason: "above-ceiling", pinned };
  }
  if (placement === "within") {
    return { decision: "fetch", reason: "within-ceiling", pinned };
  }
  return { decision: "fetch", reason: "kept", pinned };
}
