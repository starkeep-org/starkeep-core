/**
 * "Free up space": the only path that removes a file from a node, and only a
 * file a stand-in can replace.
 *
 * The platform never evicts on its own. The person names an amount and a
 * scope, and this removes eligible files largest first until the amount is
 * free:
 *
 * - **Scope `originals`** — originals, except a self-canonical original at or
 *   below the node's ceiling, which stands in for itself and is never evicted.
 * - **Scope `originals-and-above-ceiling`** — those, plus every stand-in above
 *   the ceiling, canonical stand-ins included. A stand-in at or below the
 *   ceiling is never evicted.
 *
 * ## What has to be true in the cloud first
 *
 * A removal needs complete cloud copies of the file itself, of its original,
 * and of the original's canonical stand-in — for a self-canonical original,
 * its own copy satisfies all three. A cloud record without a complete upload
 * does not count, so a file still waiting to upload stays; an original in deep
 * archive counts as held, because durable is what matters here, not readable.
 * Proof comes from the durability probes, which verify the stored checksum
 * against the record's content hash and fail closed on anything less.
 */

import {
  isStandInOriginal,
  originalStatus,
  standardsFor,
  TYPES,
  type CeilingPlacement,
  type DataRecord,
  type StandInStandards,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, Filter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { assessDurability } from "./durability.js";
import { blobCandidateForRecord } from "./sync-engine.js";
import type {
  FreeUpSpaceItem,
  FreeUpSpaceRefusal,
  FreeUpSpaceReport,
  FreeUpSpaceRequest,
} from "./residency-manager.js";
import type { BlobCandidate } from "./residency-policy.js";

export interface FreeUpSpaceDeps {
  readonly databaseAdapter: DatabaseAdapter;
  readonly localObjectStorage: ObjectStorageAdapter;
  readonly ceilingOf: (candidate: BlobCandidate) => CeilingPlacement;
  readonly standards: StandInStandards;
  /**
   * Record that bytes left, so residency reports them evicted rather than
   * never held. Writes the resident-set row first when the bytes arrived by a
   * route that never made one — a file this node wrote itself.
   */
  readonly noteRemoved: (candidate: BlobCandidate) => Promise<void>;
  /** Bytes the store answers for without holding them. See `ResidencyManagerOptions.borrowsBytes`. */
  readonly borrowsBytes?: (objectStorageKey: string) => boolean | Promise<boolean>;
}

interface Candidate {
  readonly record: DataRecord;
  readonly candidate: BlobCandidate;
  readonly kind: "original" | "stand-in";
}

/** Records read per page while enumerating; each costs one local existence check. */
const ENUMERATION_PAGE = 500;

export async function freeUpSpaceOn(
  deps: FreeUpSpaceDeps,
  request: FreeUpSpaceRequest,
): Promise<FreeUpSpaceReport> {
  const { localObjectStorage } = deps;
  const dryRun = request.dryRun === true;
  const wantBytes = Math.max(0, Math.floor(request.bytes));

  const candidates = await eligible(deps, request.scope);
  const eligibleBytes = candidates.reduce((sum, c) => sum + c.record.sizeBytes, 0);

  const removed: FreeUpSpaceItem[] = [];
  const refused: FreeUpSpaceRefusal[] = [];
  let freedBytes = 0;

  for (const candidate of candidates) {
    if (freedBytes >= wantBytes) break;
    const item: FreeUpSpaceItem = {
      recordId: candidate.record.id,
      objectStorageKey: candidate.record.objectStorageKey,
      sizeBytes: candidate.record.sizeBytes,
      kind: candidate.kind,
    };

    const proof = await proveCloudCopies(deps, candidate.record, request.probes);
    if (!proof.ok) {
      refused.push({ ...item, reason: proof.reason, detail: proof.detail });
      continue;
    }
    if (!dryRun) {
      await localObjectStorage.delete(candidate.record.objectStorageKey);
      // Departed rather than forgotten: "this node let these bytes go" is what
      // tells residency no round will bring them back, and a later request
      // lands them again.
      await deps.noteRemoved(candidate.candidate);
    }
    removed.push(item);
    freedBytes += candidate.record.sizeBytes;
  }

  return { requestedBytes: wantBytes, freedBytes, removed, refused, eligibleBytes, dryRun };
}

/**
 * Every file this node holds in the scope, largest first.
 *
 * Enumerated from the records table rather than the resident-set index: the
 * index knows only bytes that arrived by sync, and the files a person most
 * wants to free are the originals this node imported itself, which never
 * passed through it. One existence check per record in the stand-in
 * categories — a pass a person starts, not one that runs on a timer.
 */
async function eligible(deps: FreeUpSpaceDeps, scope: FreeUpSpaceRequest["scope"]): Promise<Candidate[]> {
  // Only a file a stand-in can replace is ever removable, so only types with
  // stand-in standards are worth enumerating.
  const types = TYPES.map((t) => t.id).filter((id) => standardsFor(id, deps.standards) !== null);
  const out: Candidate[] = [];
  const shapes: Filter[][] = [
    [
      { field: "parentId", operator: "isNull" },
      { field: "standInRole", operator: "isNull" },
    ],
    ...(scope === "originals-and-above-ceiling"
      ? [[{ field: "standInRole", operator: "in", value: ["canonical", "smaller"] } as Filter]]
      : []),
  ];
  for (const shape of shapes) {
    let cursor: string | undefined;
    do {
      const page = await deps.databaseAdapter.query({
        filters: [
          { field: "type", operator: "in", value: types },
          { field: "deletedAt", operator: "isNull" },
          ...shape,
        ],
        limit: ENUMERATION_PAGE,
        ...(cursor ? { cursor } : {}),
      });
      for (const record of page.records) {
        const candidate = blobCandidateForRecord(record);
        if (!candidate) continue;
        // Only files above the ceiling: a stand-in at or below it, and a
        // self-canonical original at or below it, are never evicted.
        if (deps.ceilingOf(candidate) !== "above") continue;
        // Borrowed bytes cost this node nothing, and deleting the key would
        // drop the alias rather than free space.
        if (await deps.borrowsBytes?.(record.objectStorageKey)) continue;
        if (!(await deps.localObjectStorage.has(record.objectStorageKey))) continue;
        out.push({ record, candidate, kind: record.standInRole ? "stand-in" : "original" });
      }
      cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
  }
  return out.sort((a, b) => b.record.sizeBytes - a.record.sizeBytes);
}

export type DurabilityProof =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FreeUpSpaceRefusal["reason"]; readonly detail: string };

/** What the durability proof reads. The watcher holds these two and no more. */
export interface ProveCloudCopiesDeps {
  readonly databaseAdapter: DatabaseAdapter;
  readonly standards: StandInStandards;
}

/**
 * Prove complete cloud copies of the file, its original and the original's
 * canonical stand-in. Each record is proved once however many roles it plays.
 *
 * Exported because the watcher's local-`unlink` path has to answer the same
 * question before it lets a file go: a watched file the person deleted from
 * disk is "Free up space, for this one file", and the two paths must not be
 * able to disagree about when that is safe.
 *
 * **The stand-in clauses apply only to a file a stand-in can replace.** "Free up
 * space" enumerates only types with stand-in standards, so every candidate it
 * brings here is an original or a stand-in in such a category. The watcher sees
 * every type a folder holds, and a text file or a PDF has no original and no
 * canonical stand-in to prove — demanding them would make a watched document
 * impossible to prove and therefore permanently "possibly lost", which is the
 * opposite of the truth about a file the cloud holds a verified copy of.
 */
export async function proveCloudCopies(
  deps: ProveCloudCopiesDeps,
  record: DataRecord,
  probes: FreeUpSpaceRequest["probes"],
): Promise<DurabilityProof> {
  const toProve = new Map<string, DataRecord>([[record.id, record]]);

  const inStandInCategory =
    record.standInRole !== null || record.parentId !== null || isStandInOriginal(record);
  if (inStandInCategory) {
    const outcome = await addStandInClauses(deps, record, toProve);
    if (outcome) return outcome;
  }

  for (const r of toProve.values()) {
    const verdict = await assessDurability(
      {
        objectStorageKey: r.objectStorageKey,
        contentHash: hexHash(r.contentHash),
        sizeBytes: r.sizeBytes,
      },
      probes,
    );
    if (!verdict.durable) {
      return {
        ok: false,
        reason: "not-durable",
        detail: `no complete cloud copy of ${r.id} is confirmed`,
      };
    }
  }
  return { ok: true };
}

/**
 * Add the original and the original's canonical stand-in to what must be proved.
 *
 * Returns a refusal when either is missing, because a file whose original is gone
 * or whose original has nothing to show in its place must not be removed however
 * durable its own bytes are.
 */
async function addStandInClauses(
  deps: ProveCloudCopiesDeps,
  record: DataRecord,
  toProve: Map<string, DataRecord>,
): Promise<DurabilityProof | null> {
  const { databaseAdapter, standards } = deps;
  const original =
    record.standInRole === null && record.parentId === null
      ? record
      : record.parentId
        ? await databaseAdapter.get(record.parentId)
        : null;
  if (!original || original.deletedAt || !isStandInOriginal(original)) {
    return { ok: false, reason: "record-missing", detail: "the original this file belongs to is gone" };
  }

  toProve.set(original.id, original);
  if (originalStatus(original, standards) !== "self-canonical") {
    const canonical = (
      await databaseAdapter.query({
        filters: [
          { field: "parentId", operator: "eq", value: original.id },
          { field: "standInRole", operator: "eq", value: "canonical" },
          { field: "deletedAt", operator: "isNull" },
        ],
        limit: 1,
      })
    ).records[0];
    if (!canonical) {
      return {
        ok: false,
        reason: "no-canonical",
        detail: "the original has no canonical stand-in, so it would leave nothing to show here",
      };
    }
    toProve.set(canonical.id, canonical);
  }
  return null;
}

/** Content hashes are stored bare on some write paths and `sha256:`-prefixed on others. */
function hexHash(contentHash: string): string {
  return contentHash.startsWith("sha256:") ? contentHash.slice("sha256:".length) : contentHash;
}
