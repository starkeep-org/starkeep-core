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
 * ## The rule: a matching canonical stand-in, then the cloud's first commit
 *
 * A canonical stand-in made for the threshold its original is judged by beats
 * one made for another threshold — `canonicalMatches` in protocol-primitives.
 * That is what makes replacing a canonical stand-in order-independent: the new
 * one and the old one's tombstone need not travel in the same exchange, and
 * wherever the two meet, the matching one survives. Every side applies the
 * rule the same way, so every side converges on the matching stand-in.
 *
 * When both candidates match, or neither does, either meets the standard, so
 * which one wins does not matter — only that every node agrees. The cloud is
 * the one place every stand-in passes through, so its first commit decides:
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

import type {
  DataRecord,
  HLCClock,
  StandInStandards,
  StarkeepId,
} from "@starkeep/protocol-primitives";
import { canonicalMatches, standInSlot } from "@starkeep/protocol-primitives";
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
 * Which of two canonical stand-ins for one original matches the threshold the
 * original is judged by: `incoming`, `occupant`, or `tie` when both or neither
 * do — including when this side does not hold the original yet.
 */
export async function matchingCanonical(
  db: DatabaseAdapter,
  incoming: DataRecord,
  occupant: DataRecord,
  standards: StandInStandards,
): Promise<"incoming" | "occupant" | "tie"> {
  if (incoming.standInRole !== "canonical" || incoming.parentId === null) return "tie";
  const original = await db.get(incoming.parentId);
  if (!original || original.deletedAt) return "tie";
  const incomingMatches = canonicalMatches(original, incoming, standards);
  const occupantMatches = canonicalMatches(original, occupant, standards);
  if (incomingMatches === occupantMatches) return "tie";
  return incomingMatches ? "incoming" : "occupant";
}

/**
 * Responder side: the row to store for an incoming record.
 *
 * The incoming row itself, unless it is a live stand-in that loses its slot to
 * one this side already holds — then the incoming row as this side's
 * tombstone. When the incoming row wins against an occupant, the occupant is
 * tombstoned here under a fresh clock and returned as `displaced`, so the
 * reply carries the verdict back.
 */
export async function admitIncomingStandIn(
  db: DatabaseAdapter,
  incoming: DataRecord,
  clock: HLCClock,
  standards: StandInStandards,
): Promise<{
  readonly row: DataRecord;
  readonly lostTo: StarkeepId | null;
  readonly displaced: DataRecord | null;
}> {
  const occupant = await slotOccupant(db, incoming);
  if (!occupant) return { row: incoming, lostTo: null, displaced: null };
  if ((await matchingCanonical(db, incoming, occupant, standards)) === "incoming") {
    const displaced = tombstoneOf(occupant, clock);
    await db.put(displaced);
    return { row: incoming, lostTo: null, displaced };
  }
  return { row: tombstoneOf(incoming, clock), lostTo: occupant.id, displaced: null };
}

/**
 * Requester side: the row to store for an incoming stand-in from the cloud.
 *
 * A stand-in from the cloud already won its slot there, so a local stand-in
 * holding the same slot is normally the loser: this node tombstones it and
 * the incoming row lands. The exception is a local canonical stand-in that
 * matches its original's threshold against an incoming one that does not —
 * a replacement this node made and has not shipped yet. The local one stays,
 * and the incoming row is stored as this node's tombstone, which ships back
 * to the cloud beside the replacement.
 */
export async function yieldSlotToIncoming(
  db: DatabaseAdapter,
  incoming: DataRecord,
  clock: HLCClock,
  standards: StandInStandards,
): Promise<{ readonly row: DataRecord; readonly loser: DataRecord | null }> {
  const occupant = await slotOccupant(db, incoming);
  if (!occupant) return { row: incoming, loser: null };
  if ((await matchingCanonical(db, incoming, occupant, standards)) === "occupant") {
    return { row: tombstoneOf(incoming, clock), loser: null };
  }
  const tombstone = tombstoneOf(occupant, clock);
  await db.put(tombstone);
  return { row: incoming, loser: tombstone };
}
