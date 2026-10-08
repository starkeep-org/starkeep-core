/**
 * The reaper: what finally reclaims the bytes of a deleted item.
 *
 * Nothing did, before this. A delete tombstoned the record and left the file
 * where it was, on every node and in the cloud, for ever — so storage only grew,
 * and "I deleted that" meant "I stopped seeing it".
 *
 * ## Bytes, and never a record row
 *
 * The reaper deletes bytes and the rows that ride on a record — its per-category
 * metadata row, and the label tombstones belonging to it. **It never deletes a
 * record row.** `verify()` counts tombstone rows deliberately, so hard-deleting a
 * tombstone reads as a hole and gets the tombstone re-shipped from a peer; and the
 * coverage watermark's contract states the required order plainly, that a
 * compaction floor must be persisted and raised *before* anything below it is
 * deleted. Row compaction is separate, later work with a protocol obligation
 * attached. Byte reclamation has none.
 *
 * ## Why this is safe against content-addressed dedup
 *
 * A reaper over content-addressed keys invites one specific fear: the cloud reaps
 * key K because every record on K is tombstoned, while a node holds an unsynced
 * live record on the same K, created from identical content. The existing transfer
 * path closes that gap on its own — `runTransfer` checks `destination.has(key)` and
 * uploads when the answer is no, so the round that ships the new record re-uploads
 * the bytes. The node-side case heals the same way through the acquisition scan. No
 * reaped-key ledger is needed.
 *
 * The refcount is over the *key*, not the record, for the same reason: two files
 * with identical content but different filenames are two records sharing one
 * object, and reaping on one record's tombstone would take the other's bytes.
 *
 * ## The window, and a host that cannot read it
 *
 * `trash.retentionDays` in the library's settings file, defaulting to 30. A host
 * that cannot read the winning settings file is in the dark about the library's
 * value, and **a reaper in the dark reaps nothing**: reaping to the default under
 * a library whose owner chose a year would destroy bytes the person was promised,
 * and nothing can record "reaped under a guess" and be corrected later.
 *
 * The age test is lexicographic. A serialized HLC leads with a zero-padded hex
 * wall time in milliseconds, so the cutoff is a string bound the database applies
 * directly. Clock skew on the deleting node, and the HLC's habit of taking the
 * maximum on receive, can only push a tombstone's wall time *forward*, which makes
 * a reap late rather than early — the safe direction.
 *
 * ## Borrowed bytes
 *
 * A node's store can answer for bytes it does not hold: a symlink into a watched
 * folder on a laptop, a camera-roll alias on a phone. Reaping such a key unlinks
 * the alias and frees nothing, which is why "Free up space" refuses one too.
 *
 * The refusal covers the key whole, including the metadata and label rows the
 * byte deletion carries. Those rows are what a restore brings back, and they are
 * recoverable only while they exist — a hard-deleted metadata row makes a
 * restored photograph dimensionless for ever. On a host whose bytes are still
 * readable the restore is still worth something, so nothing about the record is
 * destroyed there. The person's own file is never at risk either way: `delete`
 * unlinks the entry inside the object store and never its target.
 *
 * ## Archived objects
 *
 * Skipped for now. An object in Deep Archive owes a 180-day minimum storage
 * duration, so deleting it early is charged as if it had stayed. The follow-on
 * that removes the exception costs nothing extra: reap once
 * `max(deletedAt + retention, transition + 180 days)` has passed. Until then the
 * exception is counted in the report, so the standing cost stays visible rather
 * than becoming invisible.
 *
 * The stand-ins of an archived original are reaped normally. Their bytes are
 * instant, they are cheap to delete, and nothing will read them again.
 */

import {
  hasMetadataTable,
  serializeHLC,
  typeCategory,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";

/** Records read per page while enumerating tombstones. */
const ENUMERATION_PAGE = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ReapRequest {
  /**
   * How long a deleted item's bytes stay, or `null` when this host cannot tell.
   * Null reaps nothing and says so — see the module note.
   */
  readonly retentionDays: number | null;
  /** Prove and total, but remove nothing — the estimate a person sees first. */
  readonly dryRun?: boolean;
  /**
   * Treat this as the present. For tests, and for a caller that wants the pass to
   * read one instant throughout rather than drift across a long enumeration.
   */
  readonly nowMs?: number;
}

export interface ReapedKey {
  readonly objectStorageKey: string;
  readonly sizeBytes: number;
  /** The tombstoned records sharing the key, all of which are past the window. */
  readonly recordIds: readonly string[];
}

export interface ReapRefusal {
  readonly objectStorageKey: string;
  readonly reason: "live-record" | "within-window" | "archived" | "absent" | "borrowed";
  readonly detail: string;
}

export interface ReapReport {
  /** Distinct object keys the pass looked at. */
  readonly keysConsidered: number;
  /** Removed, or — on a dry run — would be removed. */
  readonly reaped: readonly ReapedKey[];
  readonly reclaimedBytes: number;
  readonly refused: readonly ReapRefusal[];
  /** The window the pass applied, or null when it could not read one. */
  readonly retentionDays: number | null;
  /**
   * Objects left in an archive tier under the standing exception, counted so the
   * cost it accepts stays visible.
   */
  readonly archivedSkipped: number;
  readonly dryRun: boolean;
}

export interface ReaperDeps {
  readonly databaseAdapter: DatabaseAdapter;
  /** This host's own store: the cloud's bucket, or a node's object directory. */
  readonly objectStorage: ObjectStorageAdapter;
  /**
   * Whether `objectStorage` answers for these bytes without holding them. See
   * the module note on borrowed bytes, and `ResidencyManagerOptions.borrowsBytes`
   * for the hosts that answer yes. Absent: every key the store has is held here,
   * which is the cloud's case.
   */
  readonly borrowsBytes?: (objectStorageKey: string) => boolean | Promise<boolean>;
}

/**
 * Reclaim the bytes of items deleted longer ago than the retention window.
 *
 * Reads only this host's own catalogue, which is sound because shared records sync
 * everywhere: each host reaches the same verdict about the same key from its own
 * copy, and a host that reaps bytes another host later needs re-acquires them
 * through the existing paths.
 */
export async function reapDeleted(deps: ReaperDeps, request: ReapRequest): Promise<ReapReport> {
  const dryRun = request.dryRun === true;
  const nowMs = request.nowMs ?? Date.now();

  if (request.retentionDays === null) {
    // In the dark about the library's value. Nothing is reaped and the report says
    // so, rather than falling back to a default that may be far shorter than what
    // the person chose.
    return {
      keysConsidered: 0,
      reaped: [],
      reclaimedBytes: 0,
      refused: [],
      retentionDays: null,
      archivedSkipped: 0,
      dryRun,
    };
  }

  const cutoff = serializeHLC({
    wallTime: Math.max(0, nowMs - request.retentionDays * MS_PER_DAY),
    counter: 0,
    nodeId: "",
  });

  const byKey = await tombstonesPastCutoff(deps, cutoff);
  const reaped: ReapedKey[] = [];
  const refused: ReapRefusal[] = [];
  let reclaimedBytes = 0;
  let archivedSkipped = 0;

  for (const [key, records] of byKey) {
    // The refcount, over the key rather than any one record: two files with
    // identical content under two names share one object.
    const live = await db(deps).query({
      filters: [
        { field: "objectStorageKey", operator: "eq", value: key },
        { field: "deletedAt", operator: "isNull" },
      ],
      limit: 1,
    });
    if (live.records.length > 0) {
      refused.push({
        objectStorageKey: key,
        reason: "live-record",
        detail: `${live.records[0]!.id} still holds these bytes`,
      });
      continue;
    }

    // Every record on the key has to be past the window, not just the one the
    // enumeration found: the newest tombstone is the one the promise was made
    // about.
    const all = await recordsOn(deps, key);
    const newest = all.reduce<string | null>((max, r) => {
      const stamp = r.deletedAt ? serializeHLC(r.deletedAt) : null;
      return stamp !== null && (max === null || stamp > max) ? stamp : max;
    }, null);
    if (newest === null || newest >= cutoff) {
      refused.push({
        objectStorageKey: key,
        reason: "within-window",
        detail: "a record on these bytes was deleted inside the retention window",
      });
      continue;
    }

    if (await deps.borrowsBytes?.(key)) {
      // Borrowed bytes, and the whole key is left alone rather than just its
      // removal skipped. See the module note: the bytes stay readable here, so
      // the rows that describe them have to stay too.
      refused.push({
        objectStorageKey: key,
        reason: "borrowed",
        detail: "this host only links to these bytes, so removing the key would free nothing",
      });
      continue;
    }

    const availability = (await deps.objectStorage.stat(key).catch(() => null))?.availability;
    if (availability && availability.state !== "instant") {
      // The standing exception, counted rather than silent.
      archivedSkipped += 1;
      refused.push({
        objectStorageKey: key,
        reason: "archived",
        detail:
          `the object is ${availability.state} and owes a minimum storage duration, ` +
          `so deleting it now would be charged as if it had stayed`,
      });
      continue;
    }
    if (!(await deps.objectStorage.has(key))) {
      refused.push({
        objectStorageKey: key,
        reason: "absent",
        detail: "this host does not hold these bytes",
      });
      continue;
    }

    const sizeBytes = records[0]?.sizeBytes ?? 0;
    if (!dryRun) {
      await deps.objectStorage.delete(key);
      // The rows that ride on the record, and never the record row itself. See the
      // module note on the coverage watermark.
      for (const record of all) {
        if (hasMetadataTable(typeCategory(record.type))) {
          await deps.databaseAdapter.deleteMetadata(record.type, record.id as StarkeepId);
        }
        await deps.databaseAdapter.deleteLabelsForRecord(record.id as StarkeepId);
      }
    }
    reaped.push({ objectStorageKey: key, sizeBytes, recordIds: all.map((r) => r.id) });
    reclaimedBytes += sizeBytes;
  }

  return {
    keysConsidered: byKey.size,
    reaped,
    reclaimedBytes,
    refused,
    retentionDays: request.retentionDays,
    archivedSkipped,
    dryRun,
  };
}

function db(deps: ReaperDeps): DatabaseAdapter {
  return deps.databaseAdapter;
}

/**
 * The tombstoned records whose deletion is older than the cutoff, grouped by
 * object key.
 *
 * The bound is lexicographic over the serialized HLC, which the database applies
 * directly — see the module note on why that is exact and why skew makes a reap
 * late rather than early.
 */
async function tombstonesPastCutoff(
  deps: ReaperDeps,
  cutoff: string,
): Promise<Map<string, DataRecord[]>> {
  const byKey = new Map<string, DataRecord[]>();
  let cursor: string | undefined;
  do {
    const page = await deps.databaseAdapter.query({
      filters: [
        { field: "deletedAt", operator: "isNotNull" },
        { field: "deletedAt", operator: "lt", value: cutoff },
      ],
      limit: ENUMERATION_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    for (const record of page.records) {
      if (!record.objectStorageKey) continue;
      const group = byKey.get(record.objectStorageKey);
      if (group) group.push(record);
      else byKey.set(record.objectStorageKey, [record]);
    }
    cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
  } while (cursor);
  return byKey;
}

/**
 * Every record on one object, tombstones included.
 *
 * Paged to the end rather than capped: the caller proves that *every* record on
 * the key is past the window, and a record a cap left out is one whose promise
 * goes unchecked.
 */
async function recordsOn(deps: ReaperDeps, key: string): Promise<DataRecord[]> {
  const all: DataRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.databaseAdapter.query({
      filters: [{ field: "objectStorageKey", operator: "eq", value: key }],
      limit: ENUMERATION_PAGE,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...page.records);
    cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
  } while (cursor);
  return all;
}
