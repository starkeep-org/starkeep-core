/**
 * Choosing which files one round transfers, in either direction.
 *
 * Rows travel ahead of their files, so a round's file work is a window over
 * the files still owed: in a download, the files this node wants and lacks; in
 * an upload, the files the peer says it lacks. The window is split two ways.
 *
 * ## The head allotment moves the watermark
 *
 * A bytes watermark advances only past a contiguous run of satisfied files, in
 * timestamp order per author. The files at the bottom of each author's run are
 * therefore the only ones whose arrival can move it. The head allotment takes
 * them first: per author in timestamp order, shared round-robin across
 * authors so one author's backlog cannot starve another's, until the byte
 * budget is spent. The very first file always goes, however large — refusing
 * a 400 MB video because it exceeds the budget would not make rounds smaller,
 * it would stop that author's files forever.
 *
 * ## The opportunistic allotment lets small files overtake
 *
 * A video at the bottom of an author's run holds the watermark for as long as
 * it takes to move, and every thumbnail behind it would wait for it. The
 * second allotment spends its own budget on the remaining files, smallest
 * first. They do not move the watermark while the video is still owed, but
 * they are on the other side when a reader asks, which is the point.
 *
 * Two budgets, not one shared one, because the head file is so often larger
 * than any budget: sharing would leave nothing for the small files in exactly
 * the case they exist for.
 */

import { compareHLC, type HLCTimestamp } from "@starkeep/protocol-primitives";

/** One owed file, with what the planner needs to weigh it. */
export interface ByteWindowItem<T> {
  readonly value: T;
  readonly hlc: HLCTimestamp;
  readonly bytes: number;
}

export interface ByteWindowBudget<T> {
  /** Bytes for the head allotment. The first head file goes regardless. */
  readonly headBytes: number;
  /** Bytes for the opportunistic allotment. */
  readonly opportunisticBytes: number;
  /** Most files the opportunistic allotment takes. Unbounded when absent. */
  readonly opportunisticMaxFiles?: number;
  /**
   * Sorts the opportunistic allotment before size: lower first. Lets a caller
   * prefer files it expects to succeed.
   */
  readonly opportunisticOrder?: (value: T) => number;
  /**
   * Files to leave out of both allotments this round, such as a file just found
   * missing at the other end. A skipped file is not counted in
   * {@link ByteWindowPlan.leftOver}: it is waiting, not owed to the next round.
   */
  readonly skip?: (value: T) => boolean;
}

export interface ByteWindowPlan<T> {
  /** Files in timestamp order per author: the ones that move the watermark. */
  readonly head: T[];
  /** Files taken smallest-first from what the head allotment left. */
  readonly opportunistic: T[];
  /** How many owed, unskipped files neither allotment took. */
  readonly leftOver: number;
}

/**
 * Split the owed files into the two allotments.
 *
 * `items` may arrive in any order and from any author; the author is read off
 * each item's timestamp.
 */
export function planByteWindow<T>(
  items: readonly ByteWindowItem<T>[],
  budget: ByteWindowBudget<T>,
): ByteWindowPlan<T> {
  const eligible = budget.skip ? items.filter((item) => !budget.skip!(item.value)) : [...items];
  const byAuthor = new Map<string, ByteWindowItem<T>[]>();
  for (const item of eligible) {
    const run = byAuthor.get(item.hlc.nodeId) ?? [];
    run.push(item);
    byAuthor.set(item.hlc.nodeId, run);
  }
  for (const run of byAuthor.values()) run.sort((a, b) => compareHLC(a.hlc, b.hlc));

  const taken = new Set<ByteWindowItem<T>>();
  const head: T[] = [];
  let headBytes = 0;
  // Round-robin: one file per author per pass. An author whose next file does
  // not fit stops there — taking a later file of the same author would not be
  // "head" any more, since the file before it is still owed.
  const cursors = new Map<string, number>([...byAuthor.keys()].map((author) => [author, 0]));
  const stopped = new Set<string>();
  while (stopped.size < byAuthor.size) {
    for (const [author, run] of byAuthor) {
      if (stopped.has(author)) continue;
      const index = cursors.get(author)!;
      const next = run[index];
      if (!next) {
        stopped.add(author);
        continue;
      }
      if (head.length > 0 && headBytes + next.bytes > budget.headBytes) {
        stopped.add(author);
        continue;
      }
      head.push(next.value);
      headBytes += next.bytes;
      taken.add(next);
      cursors.set(author, index + 1);
    }
  }

  const order = budget.opportunisticOrder;
  const rest = eligible
    .filter((item) => !taken.has(item))
    .sort((a, b) => {
      const byOrder = order ? order(a.value) - order(b.value) : 0;
      return byOrder !== 0 ? byOrder : a.bytes - b.bytes;
    });
  const maxFiles = budget.opportunisticMaxFiles ?? Number.POSITIVE_INFINITY;
  const opportunistic: T[] = [];
  let opportunisticBytes = 0;
  for (const item of rest) {
    if (opportunistic.length >= maxFiles) break;
    // Skip rather than stop: a larger file that does not fit must not keep a
    // smaller one later in a differently ordered list from going.
    if (opportunisticBytes + item.bytes > budget.opportunisticBytes) continue;
    opportunistic.push(item.value);
    opportunisticBytes += item.bytes;
    taken.add(item);
  }

  return { head, opportunistic, leftOver: eligible.length - taken.size };
}
