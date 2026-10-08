/**
 * Deleting a record, with the cascade and the one refusal stand-ins add.
 *
 * A listing shows one item per original, so deleting that item deletes the
 * original and everything derived from it: its stand-ins and its derived
 * records (poster frames, skims). Nothing else would ever reach them — no
 * listing shows them — so leaving them would leak storage invisibly.
 *
 * ## And the way back
 *
 * Nothing is destroyed at delete time any more, so a delete is reversible for as
 * long as the retention window lasts. {@link planRecordRestore} and
 * {@link applyRecordRestore} are the mirror image of the pair above, down to the
 * cascade order, and they are what the Trash's restore action is made of.
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
    // Tombstoned, not destroyed. The metadata row used to be the one thing a
    // delete hard-deleted, which made restore permanently incomplete: dimensions
    // and a ThumbHash are reported by an app over the bytes, and the platform
    // cannot re-derive either. The reaper performs the hard delete at the end of
    // the retention window, with everything else.
    await db.tombstoneMetadata(record.type, record.id as StarkeepId, hlc);
    await db.tombstoneLabelsForRecord(record.id as StarkeepId, hlc);
    deleted.push({ ...record, updatedAt: hlc, deletedAt: hlc, version: record.version + 1 });
  }
  return deleted;
}

export type RestorePlan =
  | { readonly ok: true; readonly record: DataRecord; readonly cascade: readonly DataRecord[] }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> };

/**
 * Plan a restore: the tombstoned record, and the tombstoned children to bring back
 * with it.
 *
 * The mirror of {@link planRecordDelete}, over the other side of the tombstone,
 * with one asymmetry that is not a choice. The delete takes its own clock reading
 * per row, deliberately, so the rows keep distinct positions in the per-node order
 * the sync scan walks — which means there is no shared stamp a restore could select
 * on. So the cascade is every tombstoned child, and the one kind that must not come
 * back is refused by {@link applyRecordRestore} as it writes, where the question
 * can be answered: two stand-ins that both lost their original are both tombstoned
 * at plan time, so the slot looks free to either until the first one lands.
 *
 * Refuses a record that is not deleted, which is not a no-op worth being quiet
 * about: a Trash view offering restore on a live record is a view reading a stale
 * page, and the person should be told rather than shown a success.
 *
 * Refuses a stand-in whose slot a live sibling already holds, for the same
 * reason. The cascade's losers are answered as the restore writes, but the record
 * itself is written first, so for it the plan-time answer is the write-time one.
 */
export async function planRecordRestore(
  db: DatabaseAdapter,
  record: DataRecord,
): Promise<RestorePlan> {
  if (!record.deletedAt) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "NotDeleted",
        detail: "this record is not deleted, so there is nothing to restore",
      },
    };
  }
  if (record.standInRole !== null && (await slotTaken(db, record))) {
    return { ok: false, status: 409, body: RESTORE_SLOT_TAKEN };
  }
  const children = await db.query({
    filters: [
      { field: "parentId", operator: "eq", value: record.id },
      { field: "deletedAt", operator: "isNotNull" },
    ],
    limit: MAX_CHILDREN,
  });
  return { ok: true, record, cascade: [...children.records] };
}

/**
 * The refusal for a stand-in whose slot a live sibling holds. Shared by the
 * planner and by the callers of {@link applyRecordRestore}, which can still meet
 * it when a sibling lands between the plan and the write.
 */
export const RESTORE_SLOT_TAKEN: Readonly<Record<string, unknown>> = {
  error: "SlotTaken",
  detail: "another stand-in already holds this record's slot, so it stays deleted",
};

/** Whether a live sibling already holds the stand-in slot this child would take. */
async function slotTaken(db: DatabaseAdapter, child: DataRecord): Promise<boolean> {
  const occupant = await db.query({
    filters: [
      { field: "parentId", operator: "eq", value: child.parentId },
      { field: "standInRole", operator: "eq", value: child.standInRole },
      // A `smaller` slot is per fidelity; `canonical` is the one slot per original.
      ...(child.standInRole === "smaller" && child.fidelity !== null
        ? [{ field: "fidelity", operator: "eq" as const, value: child.fidelity }]
        : []),
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: 1,
  });
  return occupant.records.length > 0;
}

/**
 * Lift the record's tombstone and its cascade's, each with metadata and labels.
 *
 * The mirror image of {@link applyRecordDelete}, with the order reversed: the
 * original first and the children after, so no peer applying rows in clock order
 * ever holds a live stand-in whose original is still tombstoned. The delete went
 * children-first for the same reason read the other way round.
 *
 * Each row takes its own clock reading, so last-writer-wins carries the
 * restoration everywhere the deletion reached. `version` advances, because a
 * restore is a revision of the record rather than a return to a previous one —
 * writing the old version back would let a peer's tombstone win the comparison
 * and delete the record again.
 *
 * **A stand-in whose slot is already taken when its turn comes stays deleted.** A
 * stand-in that lost its slot to another was tombstoned on purpose, and restoring
 * both would put two in one slot, which the uniqueness index on either SQL backend
 * refuses outright — so a restore that tried would fail rather than quietly do the
 * wrong thing. The question can only be answered here: at plan time both losers and
 * winners are tombstoned, so the slot looks free to either.
 *
 * Answers an empty array when the record itself lost its slot between the plan
 * and the write; a caller reports that as {@link RESTORE_SLOT_TAKEN}.
 *
 * Bytes are not this function's business. A restore inside the retention window
 * is pure row work, because the reaper has not touched them; past it, the bytes
 * are gone and an app re-reports what it can.
 */
export async function applyRecordRestore(
  db: DatabaseAdapter,
  plan: Extract<RestorePlan, { ok: true }>,
  clock: HLCClock,
): Promise<DataRecord[]> {
  const restored: DataRecord[] = [];
  for (const record of [plan.record, ...plan.cascade]) {
    const deletedAt = record.deletedAt;
    if (!deletedAt) continue;
    if (record.standInRole !== null && (await slotTaken(db, record))) {
      // The record itself lost its slot after the plan: nothing comes back, since
      // its cascade belongs to a record that stays deleted.
      if (record === plan.record) return [];
      continue;
    }
    const hlc = clock.now();
    const live: DataRecord = {
      ...record,
      deletedAt: null,
      updatedAt: hlc,
      version: record.version + 1,
    };
    // A full-row write rather than an "undelete": `put` recomputes the stand-in
    // slot, which `delete` cleared, so a restored canonical stand-in takes its
    // slot back instead of coming home without one.
    await db.put(live);
    await db.restoreMetadata(record.type, record.id as StarkeepId);
    await db.restoreLabelsForRecord(record.id as StarkeepId, deletedAt, hlc);
    restored.push(live);
  }
  return restored;
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
