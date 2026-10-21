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
 * coverage is coverage over **rows**, and a node with a sync-down ceiling can
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
 * `present-unverified`: real evidence, but not proof, and it does not count.
 * A node whose peers cannot report checksums refuses to let a file go rather
 * than guess.
 *
 * A large file uploaded in parts stores a *composite* checksum, a digest over
 * fixed-size part digests, which is not the object's SHA-256. Such a replica is
 * `confirmed` only when this node's own copy, hashed whole and in parts in one
 * read, both hashes to the record's content hash and yields the same
 * composite. The first half ties the local bytes to the key; the second ties
 * the cloud's bytes to the local ones. Without a local copy to hash, the
 * replica stays `present-unverified`.
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

import type { FilePartDigests, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  compositePartCount,
  compositeSha256Checksum,
  sha256Base64ToHex,
} from "@starkeep/storage-adapter";

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

export interface DurabilityVerdict {
  /** True when this node may drop its copy. */
  readonly durable: boolean;
  readonly confirmedReplicas: number;
  /** Of the confirmed replicas, how many could be read right now. */
  readonly instantReplicas: number;
  readonly unverifiedReplicas: number;
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
  /**
   * This node's own copy, hashed whole and in multipart parts, or `null` when
   * it holds none. Consulted only for a replica whose store reports a
   * composite checksum, and at most once per assessment however many probes
   * report one, because it reads the whole file.
   */
  readonly localPartDigests?: () => Promise<FilePartDigests | null>;
}

/**
 * Ask every probe about a key and decide whether this node may let go of it:
 * yes when at least one replica is confirmed. On a phone or a desktop the one
 * probe is the cloud, so this is "the cloud holds a verified copy".
 *
 * Probes are queried independently and a failure in one never masks another —
 * a thrown probe yields `probe-failed`, which counts as nothing rather than as
 * absence, because "I couldn't tell" must not read as "it isn't there" *or* as
 * "it's fine".
 */
export async function assessDurability(
  query: DurabilityQuery,
  probes: readonly ReplicaProbe[],
): Promise<DurabilityVerdict> {
  let local: Promise<FilePartDigests | null> | null = null;
  const localOnce = query.localPartDigests
    ? () => (local ??= query.localPartDigests!())
    : undefined;
  const once: DurabilityQuery = { ...query, localPartDigests: localOnce };
  const replicas = await Promise.all(probes.map((probe) => probeReplica(once, probe)));

  const confirmed = replicas.filter((r) => r.state === "confirmed");
  const unverified = replicas.filter((r) => r.state === "present-unverified");
  const corruptionSuspected = replicas.some(
    (r) => r.state === "checksum-mismatch" || r.state === "size-mismatch",
  );

  return {
    durable: confirmed.length >= 1,
    confirmedReplicas: confirmed.length,
    instantReplicas: confirmed.filter((r) => r.readableNow).length,
    unverifiedReplicas: unverified.length,
    corruptionSuspected,
    replicas,
  };
}

async function probeReplica(query: DurabilityQuery, probe: ReplicaProbe): Promise<ReplicaReport> {
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
  // the object's SHA-256, so it is compared with a composite of this node's
  // own copy instead.
  const partCount = compositePartCount(facts.checksumSha256);
  if (partCount !== null) {
    return probeComposite(query, probe, facts.checksumSha256, partCount, {
      readableNow,
      storageClass: facts.storageClass,
    });
  }

  // Anything else that does not decode to a SHA-256 is unverifiable, not a
  // mismatch; comparing it as one would report a healthy object as corrupt.
  const reported = sha256Base64ToHex(facts.checksumSha256);
  if (reported === null) {
    return {
      nodeId: probe.nodeId,
      state: "present-unverified",
      readableNow,
      storageClass: facts.storageClass,
      detail: "store reports a checksum that is not a sha256",
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

async function probeComposite(
  query: DurabilityQuery,
  probe: ReplicaProbe,
  reported: string,
  partCount: number,
  facts: { readonly readableNow: boolean; readonly storageClass: string | null },
): Promise<ReplicaReport> {
  // Logged, unlike the whole-object branch, because this one reads the file
  // and its verdict is the only evidence of why a large video stays put.
  const log = (message: string): void =>
    console.log(`[multipart] durability ${query.objectStorageKey} on ${probe.nodeId}: ${message}`);
  const unverified = (detail: string): ReplicaReport => {
    log(`unverified, ${detail}`);
    return { nodeId: probe.nodeId, state: "present-unverified", ...facts, detail };
  };
  if (!query.localPartDigests) {
    return unverified("store reports a multipart checksum and this node cannot hash its copy");
  }
  let local: FilePartDigests | null;
  const hashStart = Date.now();
  try {
    local = await query.localPartDigests();
  } catch (err) {
    return unverified(`hashing the local copy failed: ${(err as Error).message}`);
  }
  if (!local) return unverified("store reports a multipart checksum and this node holds no copy");
  // The local copy must be the record's bytes before it can vouch for the
  // cloud's. A local copy that is not is this node's problem, not evidence
  // about the replica, so it proves nothing either way.
  if (local.sha256Hex !== query.contentHash || local.sizeBytes !== query.sizeBytes) {
    return unverified(`the local copy hashes to ${local.sha256Hex}, not ${query.contentHash}`);
  }
  const expected = compositeSha256Checksum(local.partSha256Hex);
  if (local.partSha256Hex.length !== partCount || expected !== reported) {
    console.warn(
      `[multipart] durability ${query.objectStorageKey} on ${probe.nodeId}: MISMATCH, ` +
        `store reports ${reported}, the local copy gives ${expected}`,
    );
    return {
      nodeId: probe.nodeId,
      state: "checksum-mismatch",
      ...facts,
      detail: `store reports multipart checksum ${reported}, the local copy gives ${expected}`,
    };
  }
  log(
    `confirmed ${partCount} parts against the local copy, hashed in ${Date.now() - hashStart} ms`,
  );
  return { nodeId: probe.nodeId, state: "confirmed", ...facts };
}
