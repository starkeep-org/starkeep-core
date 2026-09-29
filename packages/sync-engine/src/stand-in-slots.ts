/**
 * Two stand-ins for one slot, arriving by sync.
 *
 * Two nodes — or two apps on two nodes — can each produce a canonical stand-in
 * for one original while offline, or each produce the same standard size.
 * Different encoders produce different bytes, so the two records have
 * different ids and content hashes cannot merge them. The stores' slot index
 * (`standInSlot` in protocol-primitives) refuses the second one, and an
 * unhandled refusal inside a sync apply would stop sync for the whole channel.
 *
 * ## The rule: the cloud's first commit wins
 *
 * Either candidate meets the standard, so which one wins does not matter —
 * only that every node agrees. The cloud is the one place every stand-in
 * passes through, so its first commit decides:
 *
 * - **At the cloud**, an incoming stand-in whose slot is already held by a
 *   different live stand-in is stored as a tombstone under a fresh cloud
 *   clock. The tombstone sits above the sender's watermark for the cloud, so
 *   the same exchange's response carries it back, and the sender's copy dies
 *   by ordinary last-writer-wins. No protocol change and no special reply.
 * - **At a node**, an incoming stand-in comes from the cloud and therefore
 *   already won there. A local stand-in holding the same slot under a different
 *   id is the loser; the node tombstones it under a fresh local clock before
 *   the winner applies, and that tombstone ships harmlessly on the next push.
 *
 * Tombstoning rather than dropping keeps both halves on the one path sync
 * already trusts: a deleted record is a row with `deletedAt`, and it
 * propagates like any other write.
 */

import type { DataRecord, HLCClock, StarkeepId } from "@starkeep/protocol-primitives";
import { standInSlot } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";

/** The live stand-in holding the same slot as `record` under another id. */
export async function slotOccupant(
  db: DatabaseAdapter,
  record: DataRecord,
): Promise<DataRecord | null> {
  const slot = standInSlot(record);
  if (slot === null || record.parentId === null || record.standInRole === null) return null;
  const result = await db.query({
    filters: [
      { field: "parentId", operator: "eq", value: record.parentId },
      { field: "standInRole", operator: "eq", value: record.standInRole },
      ...(record.standInRole === "smaller"
        ? [{ field: "fidelity", operator: "eq" as const, value: record.fidelity }]
        : []),
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: 2,
  });
  return result.records.find((r) => r.id !== record.id) ?? null;
}

/** `record`, tombstoned by this side under a fresh clock. */
export function tombstoneOf(record: DataRecord, clock: HLCClock): DataRecord {
  const now = clock.now();
  return { ...record, deletedAt: now, updatedAt: now, version: record.version + 1 };
}

/**
 * Responder side: the row to store for an incoming record.
 *
 * The incoming row itself, unless it is a live stand-in that loses its slot to
 * one this side already holds — then the incoming row as this side's
 * tombstone.
 */
export async function admitIncomingStandIn(
  db: DatabaseAdapter,
  incoming: DataRecord,
  clock: HLCClock,
): Promise<{ readonly row: DataRecord; readonly lostTo: StarkeepId | null }> {
  const occupant = await slotOccupant(db, incoming);
  if (!occupant) return { row: incoming, lostTo: null };
  return { row: tombstoneOf(incoming, clock), lostTo: occupant.id };
}

/**
 * Requester side: clear the slot an incoming stand-in from the cloud is about
 * to take, by tombstoning this node's own occupant. Returns the tombstone
 * written, or null when the slot was free.
 */
export async function yieldSlotToIncoming(
  db: DatabaseAdapter,
  incoming: DataRecord,
  clock: HLCClock,
): Promise<DataRecord | null> {
  const occupant = await slotOccupant(db, incoming);
  if (!occupant) return null;
  const tombstone = tombstoneOf(occupant, clock);
  await db.put(tombstone);
  return tombstone;
}
