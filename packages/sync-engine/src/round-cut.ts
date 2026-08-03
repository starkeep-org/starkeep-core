/**
 * Deciding what one round may ship — the single expression of the invariant the
 * whole protocol rests on.
 *
 * ## The invariant
 *
 * > What you ship must be a contiguous prefix, in HLC order, per author, across
 * > **everything the coverage watermark covers**.
 *
 * And it covers a lot. A responder folds `shared_records`, `shared_record_labels`
 * and every registered app-syncable table into one timestamp per author
 * (`in-process-transport.ts`, step 5). The receiver then advances a single
 * watermark per author over the merged inbound stream. One scalar, N tables.
 *
 * A delta scan, by construction, runs **per table** — that is exactly what the
 * `(node_id, updated_at)` index buys. So the shipped set is assembled from N
 * independent scans and covered by one watermark, and the cut point is not free:
 *
 * > You may only ship items for author N below an HLC that every stream has
 * > enumerated completely for N.
 *
 * ## Why sorting and cutting is not enough
 *
 * It is tempting — and was, for a while — to say "sort the candidates globally by
 * HLC and stop when the budget runs out; the invariant holds because the cut is
 * at a point in timestamp order". It does not hold. Cutting a sorted list yields a
 * contiguous prefix only if the list is a *complete* enumeration below the cut.
 * Give each scan its own limit and it is not: the record scan can stop inside
 * author `aaa` while the label scan runs on to `bbb`, and the merged list then
 * contains `bbb`'s label with `bbb`'s earlier record simply absent — not
 * deferred, never a candidate. Cut wherever you like; the gap is already inside
 * the list.
 *
 * The peer applies the label, lifts its watermark for `bbb` past the record, and
 * no round ever offers that record again. Silent and permanent, which is the
 * failure mode this entire design exists to prevent.
 *
 * ## The construction
 *
 * Each stream reports how far it got, per author ({@link StreamTruncation}).
 * {@link computeCeilings} takes the **minimum** across streams: an author's
 * ceiling is the lowest point any stream can still vouch for.
 * {@link cutRound} drops everything above the ceiling, then spends the round's
 * byte and item budgets in HLC order.
 *
 * Both halves of the protocol call this — the requester deciding what to push and
 * the responder deciding what to ship back. They had diverged, and the responder's
 * copy was wrong. One module, two callers, no second opinion.
 */

import { compareHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";

/**
 * How far one stream's scan got, per author.
 *
 * - absent → enumerated completely; this stream imposes no ceiling.
 * - `HLCTimestamp` → complete up to and including that row, no further.
 * - `null` → not read at all; nothing is safe to ship for that author.
 */
export type StreamTruncation = Readonly<Record<string, HLCTimestamp | null>>;

/** An item eligible for a round, with everything the cut needs to weigh it. */
export interface RoundItem<T> {
  readonly value: T;
  readonly hlc: HLCTimestamp;
  /**
   * Blob bytes this item will transfer, or 0 when it carries none.
   *
   * Zero is not a rounding convenience — it is the reason one pair of budgets
   * suits both a channel of photos and a channel of captions. A row with no blob
   * costs nothing to move, so it is bounded by the item cap alone.
   */
  readonly bytes: number;
}

export interface RoundBudget {
  readonly maxBytes: number;
  readonly maxItems: number;
}

export interface CutResult<T> {
  readonly taken: RoundItem<T>[];
  /**
   * Something was held back — by a ceiling, by the byte budget, or by the item
   * cap. The caller's signal to come back for another round, never a cursor:
   * what was held back is re-selected from the top next time, because the peer's
   * watermark has not advanced past it.
   */
  readonly hasMore: boolean;
}

/**
 * The lowest point every stream can vouch for, per author.
 *
 * `null` in the result means "no safe point at all" — some stream did not read
 * that author, so nothing may ship for it this round. An author absent from the
 * result has no ceiling: every stream enumerated it completely.
 */
export function computeCeilings(
  truncations: readonly StreamTruncation[],
): Map<string, HLCTimestamp | null> {
  const ceilings = new Map<string, HLCTimestamp | null>();
  for (const truncation of truncations) {
    for (const [nodeId, ceiling] of Object.entries(truncation)) {
      if (!ceilings.has(nodeId)) {
        ceilings.set(nodeId, ceiling);
        continue;
      }
      const current = ceilings.get(nodeId)!;
      // `null` is the floor of this lattice: one stream that read nothing for an
      // author overrides every other stream's promise about it.
      if (current === null) continue;
      if (ceiling === null || compareHLC(ceiling, current) < 0) {
        ceilings.set(nodeId, ceiling);
      }
    }
  }
  return ceilings;
}

/** Whether `item` sits at or below its author's ceiling. */
function withinCeiling(
  item: RoundItem<unknown>,
  ceilings: ReadonlyMap<string, HLCTimestamp | null>,
): boolean {
  if (!ceilings.has(item.hlc.nodeId)) return true;
  const ceiling = ceilings.get(item.hlc.nodeId)!;
  if (ceiling === null) return false;
  return compareHLC(item.hlc, ceiling) <= 0;
}

/**
 * Choose the round's shipment: everything at or below its author's ceiling,
 * earliest first, until a budget is spent.
 *
 * The sort is load-bearing and all streams have to be in it rather than one
 * appended after another — deferring a label whose HLC precedes a shipped record
 * would leave the peer holding a gap, and a coverage watermark over a gap is a
 * false claim.
 *
 * The budget is **bytes first, item count second**. An item count alone cannot
 * express what a round costs: six photos is ~18 MB and six labels is nothing.
 *
 * The first item is always taken, however large. Refusing a 400 MB video because
 * it exceeds the budget would not make rounds smaller, it would stall that
 * channel permanently.
 */
export function cutRound<T>(
  items: readonly RoundItem<T>[],
  ceilings: ReadonlyMap<string, HLCTimestamp | null>,
  budget: RoundBudget,
): CutResult<T> {
  const eligible: RoundItem<T>[] = [];
  let heldByCeiling = false;
  for (const item of items) {
    if (withinCeiling(item, ceilings)) eligible.push(item);
    else heldByCeiling = true;
  }
  eligible.sort((a, b) => compareHLC(a.hlc, b.hlc));

  const taken: RoundItem<T>[] = [];
  let bytes = 0;
  let heldByBudget = false;
  for (const item of eligible) {
    const overBudget =
      taken.length > 0 &&
      (taken.length >= budget.maxItems || bytes + item.bytes > budget.maxBytes);
    if (overBudget) {
      heldByBudget = true;
      break;
    }
    taken.push(item);
    bytes += item.bytes;
  }

  // A ceiling exists only because some stream returned fewer rows than it had,
  // so its mere presence means more is owed — even when nothing was visibly
  // held back here, which is the common case: the scan stopped *at* the
  // ceiling, so every candidate it handed over is under it. Reading `hasMore`
  // off the filtering alone would report a drained channel with a backlog
  // still sitting in the table.
  return {
    taken,
    hasMore: ceilings.size > 0 || heldByCeiling || heldByBudget,
  };
}
