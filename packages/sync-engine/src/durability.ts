/**
 * The blob-level durability predicate: "are these bytes safely somewhere else,
 * such that this node may delete its copy?"
 *
 * **This is the only part of the residency work that destroys data if it is
 * wrong.** Everything here is written to fail closed. An unproven replica is
 * not a replica; a probe that errors is not evidence of presence; and the
 * watermark is not admissible at all.
 *
 * ## Why the watermark may not stand in for this
 *
 * A coverage watermark says "I have durably incorporated everything from node
 * N up to H." Before residency, that implied the blobs too. It no longer does:
 * `Elided` makes the gap structural, because a peer advances its watermark
 * *precisely because* it declined the blob. Evicting on watermark evidence
 * therefore means deleting a last copy on the word of a node that does not
 * have it either. There is no version of that which is safe, so no code path
 * here accepts a watermark as input.
 *
 * The rule has a reporting half, stated on
 * `SyncExchangeResponse.responderWatermarks`: what a node advertises as
 * coverage is coverage over **rows**, and a node with a retention budget can
 * honestly advertise records whose blobs it declined. The two halves are one
 * rule — *a timestamp is never evidence about bytes* — and they are written
 * down in both places because each is separately easy to "simplify" into a
 * watermark comparison by someone who has only read the other.
 *
 * ## What counts as a replica
 *
 * `HeadObject` (via `stat()`) returns size, stored checksum, storage class and
 * restore state in one call. Our keys *are* the SHA-256, so a replica is
 * `confirmed` only when the store reports a checksum matching the record's
 * content hash. A merely-present object of the right size is
 * `present-unverified`: real evidence, but not proof, and by default it does
 * not count — see {@link DurabilityPolicy.countUnverified}.
 *
 * ## Durable is not the same as readable
 *
 * A Deep Archive copy is perfectly durable and cannot be read for twelve
 * hours. Both facts are reported (`confirmedReplicas` vs `instantReplicas`) so
 * a caller can refuse to drop its last *instantly readable* copy without
 * pretending the archived one doesn't exist. Conflating the two produces
 * either a needless refusal or a twelve-hour surprise, and the two mistakes
 * are not symmetric.
 */

import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { sha256Base64ToHex } from "@starkeep/storage-adapter";

/** A peer whose storage this node can interrogate about a key. */
export interface ReplicaProbe {
  /** Stable identity of the peer, for reporting. */
  readonly nodeId: string;
  readonly storage: ObjectStorageAdapter;
}

export type ReplicaState =
  /** Present, and the store's own checksum matches the record's content hash. */
  | "confirmed"
  /** Present and the right size, but the store carries no checksum to check. */
  | "present-unverified"
  /** Present and the wrong size. Never counts. */
  | "size-mismatch"
  /** Present and the store's checksum disagrees. Never counts; report loudly. */
  | "checksum-mismatch"
  /** No object at this key. */
  | "absent"
  /** The probe itself failed. Not evidence of presence, and not evidence of absence. */
  | "probe-failed";

export interface ReplicaReport {
  readonly nodeId: string;
  readonly state: ReplicaState;
  /** Whether this replica could be read right now, when it exists. */
  readonly readableNow: boolean;
  readonly storageClass: string | null;
  readonly detail?: string;
}

/**
 * The floor under {@link DurabilityPolicy.minimumReplicas}, and the reason this
 * module has one at all.
 *
 * The predicate is `counted >= policy.minimumReplicas`. At zero that is true for
 * every blob with **zero probes and zero evidence** — every deletion authorized,
 * no questions asked — and the number arrives from a JSON config file
 * (`starkeepConfig.minimumReplicas ?? 1`, passed straight through) where nothing
 * validated it. The field's own documentation says this number "is the only
 * thing that keeps that from being a data-loss feature", which is exactly the
 * kind of claim that should not depend on every caller remembering to clamp.
 *
 * Clamped here as well as where the config is read. Two places for one rule
 * looks redundant and is not: the config clamp is what tells an operator their
 * setting was refused, and this one is what holds when a caller is constructed
 * some other way — a test, a future host, a policy assembled in code.
 */
export const MINIMUM_REPLICAS_FLOOR = 1;

export interface DurabilityPolicy {
  /**
   * How many confirmed replicas elsewhere before this node may drop its copy.
   * One is the minimum that is arithmetically defensible and still leaves no
   * margin for a second failure; the plan's `no-cloud` mode is precisely the
   * case where the operator should raise it.
   *
   * Values below {@link MINIMUM_REPLICAS_FLOOR} are raised to it rather than
   * honoured. There is no coherent reading of "delete my only copy once zero
   * other copies are confirmed".
   */
  readonly minimumReplicas: number;
  /**
   * Whether `present-unverified` replicas count toward the minimum.
   *
   * Default **false**, deliberately. The consequence is that a node whose
   * peers cannot report checksums will refuse to evict rather than guess —
   * which is the plan's stated stance ("a reduction that would evict originals
   * must refuse rather than proceed, and say so"). Turning this on trades that
   * refusal for a weaker guarantee, and it should be a decision someone makes
   * on purpose.
   */
  readonly countUnverified?: boolean;
}

export interface DurabilityVerdict {
  /** True when this node may drop its copy. */
  readonly durable: boolean;
  readonly confirmedReplicas: number;
  /** Of the confirmed replicas, how many could be read right now. */
  readonly instantReplicas: number;
  readonly unverifiedReplicas: number;
  readonly minimumRequired: number;
  /**
   * Set when any probe reported a checksum or size disagreement. This is not a
   * "not durable enough" condition — it is evidence that a copy somewhere is
   * corrupt, and it should reach a human rather than merely suppressing an
   * eviction.
   */
  readonly corruptionSuspected: boolean;
  readonly replicas: readonly ReplicaReport[];
}

export interface DurabilityQuery {
  readonly objectStorageKey: string;
  /** Lowercase hex SHA-256 from the record. The key encodes it too; both are checked. */
  readonly contentHash: string;
  readonly sizeBytes: number;
}

/**
 * Ask every probe about a key and decide whether this node may let go of it.
 *
 * Probes are queried independently and a failure in one never masks another —
 * a thrown probe yields `probe-failed`, which counts as nothing rather than as
 * absence, because "I couldn't tell" must not read as "it isn't there" *or* as
 * "it's fine".
 */
export async function assessDurability(
  query: DurabilityQuery,
  probes: readonly ReplicaProbe[],
  policy: DurabilityPolicy,
): Promise<DurabilityVerdict> {
  const replicas = await Promise.all(
    probes.map((probe) => probeReplica(query, probe)),
  );

  const confirmed = replicas.filter((r) => r.state === "confirmed");
  const unverified = replicas.filter((r) => r.state === "present-unverified");
  const corruptionSuspected = replicas.some(
    (r) => r.state === "checksum-mismatch" || r.state === "size-mismatch",
  );

  const counted = confirmed.length + (policy.countUnverified ? unverified.length : 0);
  // See MINIMUM_REPLICAS_FLOOR. A zero here makes `counted >= minimum` true for
  // a blob nothing was asked about, which is the one arithmetic in this file
  // that turns "fail closed" into "delete everything".
  //
  // Non-finite is checked explicitly rather than left to `Math.max`, which
  // returns `NaN` for one. The verdict was still safe — every comparison against
  // a NaN is false, so `durable` came out false — but safe *by accident*, in
  // exactly the way the note above objects to: the guarantee emerged from
  // arithmetic somewhere else rather than from the clamp that claims to provide
  // it. And it was reported dishonestly, since `minimumRequired: NaN` tells a
  // caller inspecting the verdict nothing about the threshold actually applied.
  const minimumRequired = Number.isFinite(policy.minimumReplicas)
    ? Math.max(policy.minimumReplicas, MINIMUM_REPLICAS_FLOOR)
    : MINIMUM_REPLICAS_FLOOR;

  return {
    durable: counted >= minimumRequired,
    confirmedReplicas: confirmed.length,
    instantReplicas: confirmed.filter((r) => r.readableNow).length,
    unverifiedReplicas: unverified.length,
    minimumRequired,
    corruptionSuspected,
    replicas,
  };
}

async function probeReplica(
  query: DurabilityQuery,
  probe: ReplicaProbe,
): Promise<ReplicaReport> {
  let facts;
  try {
    facts = await probe.storage.stat(query.objectStorageKey);
  } catch (err) {
    return {
      nodeId: probe.nodeId,
      state: "probe-failed",
      readableNow: false,
      storageClass: null,
      detail: (err as Error).message,
    };
  }

  if (!facts) {
    return { nodeId: probe.nodeId, state: "absent", readableNow: false, storageClass: null };
  }

  const readableNow = facts.availability.state === "instant";

  if (facts.sizeBytes !== query.sizeBytes) {
    return {
      nodeId: probe.nodeId,
      state: "size-mismatch",
      readableNow,
      storageClass: facts.storageClass,
      detail: `expected ${query.sizeBytes} bytes, store reports ${facts.sizeBytes}`,
    };
  }

  if (facts.checksumSha256 === null) {
    return {
      nodeId: probe.nodeId,
      state: "present-unverified",
      readableNow,
      storageClass: facts.storageClass,
    };
  }

  // A multipart object's stored checksum is a composite over part digests, not
  // the object's SHA-256. `sha256Base64ToHex` returns null for it rather than
  // decoding it into something that would compare as a mismatch — which would
  // otherwise report every large object as corrupt.
  const reported = sha256Base64ToHex(facts.checksumSha256);
  if (reported === null) {
    return {
      nodeId: probe.nodeId,
      state: "present-unverified",
      readableNow,
      storageClass: facts.storageClass,
      detail: "store reports a composite (multipart) checksum, which is not the object's sha256",
    };
  }

  if (reported !== query.contentHash) {
    return {
      nodeId: probe.nodeId,
      state: "checksum-mismatch",
      readableNow,
      storageClass: facts.storageClass,
      detail: `store reports sha256 ${reported}, record says ${query.contentHash}`,
    };
  }

  return {
    nodeId: probe.nodeId,
    state: "confirmed",
    readableNow,
    storageClass: facts.storageClass,
  };
}
