/**
 * Deleting a record, with the cascade and the one refusal stand-ins add.
 *
 * A listing shows one item per original, so deleting that item deletes the
 * original and everything derived from it: its stand-ins and its derived
 * records (poster frames, skims). Nothing else would ever reach them — no
 * listing shows them — so leaving them would leak storage invisibly.
 *
 * The refusal: a canonical stand-in cannot be deleted on its own while its
 * original is live. The design's hard rule is narrower — the cloud must never
 * lose the canonical stand-in of an *archived* original — but a node cannot
 * see whether the cloud has archived an original, and a node that allowed the
 * delete would ship a tombstone the cloud then has to refuse. One rule on both
 * servers keeps the two answers the same.
 */

import type { DataRecord, HLCClock, StarkeepId } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";

/** Upper bound on one original's children; far above any real original. */
const MAX_CHILDREN = 1_000;

export type DeletePlan =
  | { readonly ok: true; readonly record: DataRecord; readonly cascade: readonly DataRecord[] }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };

export async function planRecordDelete(db: DatabaseAdapter, record: DataRecord): Promise<DeletePlan> {
  if (record.standInRole === "canonical" && record.parentId) {
    const original = await db.get(record.parentId);
    if (original && !original.deletedAt) {
      return {
        ok: false,
        status: 409,
        body: {
          error: "CanonicalStandIn",
          detail:
            "the canonical stand-in is what the person sees once the original is archived; " +
            "delete the original to delete both",
        },
      };
    }
  }
  const children = await db.query({
    filters: [
      { field: "parentId", operator: "eq", value: record.id },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: MAX_CHILDREN,
  });
  return { ok: true, record, cascade: children.records };
}

/**
 * Tombstone the record and its cascade, each with its metadata and labels.
 *
 * Each row takes its own clock reading rather than sharing one, so the rows
 * keep distinct positions in the per-node order the sync scan walks.
 * Tombstones rather than removals, so the cascade itself syncs.
 */
export async function applyRecordDelete(
  db: DatabaseAdapter,
  plan: Extract<DeletePlan, { ok: true }>,
  clock: HLCClock,
): Promise<DataRecord[]> {
  const deleted: DataRecord[] = [];
  // Children first: a peer applying rows in clock order then never holds a
  // live stand-in whose original is already gone.
  for (const record of [...plan.cascade, plan.record]) {
    const hlc = clock.now();
    await db.delete(record.id as StarkeepId, hlc);
    await db.deleteMetadata(record.type, record.id as StarkeepId);
    await db.tombstoneLabelsForRecord(record.id as StarkeepId, hlc);
    deleted.push({ ...record, updatedAt: hlc, deletedAt: hlc, version: record.version + 1 });
  }
  return deleted;
}

/** What the keep rule reads of a record in the incoming exchange. */
type ExchangedRecord = Pick<DataRecord, "id" | "deletedAt">;

/**
 * Whether the cloud must refuse a synced tombstone of `current`.
 *
 * The canonical stand-in of an archived original is all a person can see of
 * the photograph until a restore, so the cloud keeps it: the sync transport
 * stores the live row instead and ships it back to the node that deleted it.
 * One tombstone passes: one that arrives with its original's own tombstone in
 * the same exchange, which is a delete of the whole item.
 *
 * `exchange` is the incoming request, read for the original's tombstone.
 */
export async function keepCanonicalOfArchivedOriginal(
  db: DatabaseAdapter,
  current: DataRecord,
  exchange: { records?: ReadonlyArray<ExchangedRecord> },
): Promise<boolean> {
  if (current.standInRole !== "canonical" || !current.parentId) return false;
  const parentId = current.parentId;
  const incoming = exchange.records ?? [];
  if (incoming.some((r) => r.id === parentId && r.deletedAt)) return false;
  const original = await db.get(parentId);
  if (!original || original.deletedAt || !original.objectStorageKey) return false;
  const row = (await db.getAvailability([original.objectStorageKey])).get(original.objectStorageKey);
  return row?.state === "archived" || row?.state === "restoring";
}
