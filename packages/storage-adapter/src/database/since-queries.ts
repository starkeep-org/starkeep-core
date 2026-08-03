/**
 * Delta-scan SQL: "give me the rows this peer has not seen", built once for
 * both backends.
 *
 * ## Why this exists
 *
 * The sync outbound scan used to read the table in primary-key order and drop
 * rows the peer already had **in JavaScript, after they came back**. That makes
 * every round cost O(total rows) rather than O(rows still owed): a node that has
 * shipped 30k of 60k records still read 30k rows to find the next 100.
 *
 * The fix needs no new index. `(node_id, updated_at)` already exists on every
 * table this runs against, on both engines, because it backs the responder's
 * coverage-watermark query:
 *
 *   - `idx_shared_records_node_watermark` / `idx_shared_record_labels_node_watermark`
 *     (SQLite, `storage-sqlite/src/schema/bootstrap.ts`)
 *   - `idx_records_node_watermark` / `idx_record_labels_node_watermark`
 *     (DSQL, `admin-installer/src/dsql-schema-init.ts`)
 *   - `idx_<schema>_<table>_node_watermark` on every app-syncable table
 *     (`admin-installer/src/local/registry.ts` and `src/dsql-ddl.ts`)
 *
 * ## Why one query per node rather than one query for all of them
 *
 * A watermark is per author, so a delta is a union of per-author ranges. Those
 * could be one statement — an `OR` of `(node_id = ? AND updated_at > ?)` pairs,
 * or a `UNION ALL` of per-node limited subqueries — but both compile to
 * something a query planner may or may not turn back into clean index seeks,
 * and the `OR` form in particular can degrade to the full index scan this
 * module exists to avoid.
 *
 * A loop of single-node seeks cannot degrade. It costs one round trip per
 * author that actually has something to send, and the author count is a user's
 * device count — one to a handful, not a scaling dimension. For the most
 * safety-critical scan in the system, a shape that is obviously correct and
 * obviously indexed beats one that is fewer round trips and needs a query plan
 * to confirm.
 *
 * {@link planNodeScans} is what keeps that cheap: it compares each author's
 * local maximum against the peer's watermark first, so **steady state issues no
 * range queries at all** — one grouped index-only read, no rows owed, done.
 *
 * ## Ordering
 *
 * Rows come back grouped by author and ascending within each author. There is
 * deliberately no global ordering across authors: the sync engine buckets by
 * author and sorts within the bucket anyway, and the only place a global order
 * matters is the round's size cap, which sorts explicitly.
 *
 * ## What this module does *not* establish
 *
 * A globally-earliest prefix of one stream's rows is a contiguous prefix per
 * author **of that stream**. It is not a contiguous prefix of what the coverage
 * watermark covers, because that watermark spans every table on the channel —
 * records, labels, and each app-syncable table. Shipping a label whose HLC sits
 * above a record this scan was cut short of would lift the peer's watermark over
 * the record and lose it permanently.
 *
 * So this module reports how far it got ({@link SincePage.truncated}) and leaves
 * the decision to `sync-engine/src/round-cut.ts`, which is the one place that
 * knows about all the streams at once. Do not reintroduce a cut here.
 */

import type { CompiledQuery, Kysely } from "kysely";
import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import { compareHLC, serializeHLC } from "@starkeep/protocol-primitives";

/** The dynamic (schema-less) row type both adapters' compilers are built on. */
export type SinceDb = Record<string, Record<string, unknown>>;

/** One author's slice of a delta scan. */
export interface NodeScan {
  readonly nodeId: string;
  /**
   * Serialized-HLC exclusive lower bound, or null when the peer has never
   * reported anything from this author and therefore needs all of it.
   */
  readonly since: string | null;
}

/**
 * Work out which authors actually owe the peer something, cheaply.
 *
 * `localWatermarks` is this side's `MAX(updated_at)` per author — one grouped
 * read off the same index the seeks use. An author whose local maximum is
 * at-or-below what the peer reports has nothing to send, and is skipped without
 * touching the table.
 *
 * Sorted by nodeId so a scan is deterministic across calls. That matters less
 * than it looks — the caller re-sorts — but a scan that returns different
 * authors on identical inputs is miserable to debug.
 */
export function planNodeScans(
  localWatermarks: Record<string, HLCTimestamp>,
  peerWatermarks: Record<string, HLCTimestamp>,
): NodeScan[] {
  const scans: NodeScan[] = [];
  for (const nodeId of Object.keys(localWatermarks).sort()) {
    const localMax = localWatermarks[nodeId]!;
    const peerHlc = peerWatermarks[nodeId];
    // Nothing newer than what the peer already reports holding.
    if (peerHlc && compareHLC(localMax, peerHlc) <= 0) continue;
    scans.push({ nodeId, since: peerHlc ? serializeHLC(peerHlc) : null });
  }
  return scans;
}

/**
 * One author's rows above `since`, oldest first, capped at `limit + 1`.
 *
 * The extra row is how the caller distinguishes "that was everything" from
 * "there is more owed", which drives both the round's `hasMore` and the loop
 * that decides whether to sync again.
 *
 * `updated_at` is a serialized HLC — fixed-width hex wall time, then counter,
 * then nodeId — so lexicographic order is HLC order and a plain string
 * comparison is a correct range bound. Within one author it is also unique, so
 * no tiebreaker column is needed.
 */
export function buildScanSinceForNode(
  k: Kysely<SinceDb>,
  table: string,
  scan: NodeScan,
  limit: number,
): CompiledQuery {
  let q = k.selectFrom(table).selectAll().where("node_id", "=", scan.nodeId);
  if (scan.since !== null) {
    q = q.where("updated_at", ">", scan.since);
  }
  return q
    .orderBy("updated_at", "asc")
    .limit(limit + 1)
    .compile();
}

/**
 * What one stream's delta scan returned, and — critically — how far it got.
 *
 * `truncated` is the load-bearing field. A coverage watermark is per author and
 * spans *every* table the channel carries, so a caller may only ship an item for
 * author N once it knows nothing older is still owed for N **in any stream**. A
 * stream that stopped early cannot promise that above the last row it returned,
 * and this is where it says so. See `sync-engine/src/round-cut.ts`, which turns
 * these marks into the ceiling every shipment is cut against.
 *
 * - absent entry → this stream enumerated that author completely; no ceiling.
 * - `HLCTimestamp` → complete only up to and including that row.
 * - `null` → the author was not read at all; nothing is safe to ship for it.
 */
export interface SincePage<TRow> {
  readonly rows: TRow[];
  readonly hasMore: boolean;
  readonly truncated: Record<string, HLCTimestamp | null>;
}

/**
 * Drive {@link planNodeScans} + {@link buildScanSinceForNode} across authors.
 *
 * ## The budget is split per author, not spent in author order
 *
 * The obvious loop — walk authors, spend the budget, stop when it runs out —
 * starves. Authors are visited in a fixed order, so an author that cannot drain
 * (one permanently failing blob is enough to hold a round's shipment back
 * forever) blocks every author sorted after it, permanently. It also makes the
 * common case worse: on a first sync the alphabetically-first device owns the
 * whole budget until it finishes.
 *
 * Each author therefore gets its own slice. The divisor is the number of authors
 * that actually owe something — {@link planNodeScans} has already discarded the
 * rest — so a lone author still gets the whole budget, and an author that drains
 * hands its share back on the next round automatically. That is what keeps the
 * fairness from costing throughput in the case that matters.
 *
 * Rows left behind are not an error and not a cursor: the peer's watermark has
 * not advanced past them, so the next round selects them again from the top.
 */
export async function collectSince<TRow>(
  scans: readonly NodeScan[],
  limit: number,
  runScan: (scan: NodeScan, remaining: number) => Promise<TRow[]>,
  hlcOf: (row: TRow) => HLCTimestamp,
): Promise<SincePage<TRow>> {
  if (scans.length === 0) return { rows: [], hasMore: false, truncated: {} };

  const truncated: Record<string, HLCTimestamp | null> = {};
  if (limit <= 0) {
    // Authors owe something and we are returning none of it, so nothing is
    // safe to ship for any of them. `null`, not "complete".
    for (const scan of scans) truncated[scan.nodeId] = null;
    return { rows: [], hasMore: true, truncated };
  }

  // At least one row per author, so an author is never silently skipped — the
  // whole point of splitting rather than spending in order.
  const share = Math.max(1, Math.ceil(limit / scans.length));

  const rows: TRow[] = [];
  let hasMore = false;
  for (const scan of scans) {
    const page = await runScan(scan, share);
    if (page.length > share) {
      const kept = page.slice(0, share);
      rows.push(...kept);
      truncated[scan.nodeId] = hlcOf(kept[kept.length - 1]!);
      hasMore = true;
    } else {
      rows.push(...page);
    }
  }
  return { rows, hasMore, truncated };
}
