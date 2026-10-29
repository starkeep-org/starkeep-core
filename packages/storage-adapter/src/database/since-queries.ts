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
 * range queries at all** — one watermark read, no rows owed, done. A backend
 * that bills by rows read takes that read relative to the peer's watermarks
 * ({@link readNodeWatermarks}), so the steady state reads almost nothing.
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
import { compareHLC, deserializeHLC, serializeHLC } from "@starkeep/protocol-primitives";

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
 * `localWatermarks` is this side's `MAX(updated_at)` per author — one read off
 * the same index the seeks use. An author whose local maximum is at-or-below
 * what the peer reports has nothing to send, and is skipped without touching the
 * table. An author below the peer may therefore be absent from the map, which
 * is what lets {@link readNodeWatermarks} omit it.
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
 * Per-author `MAX(updated_at)` over every row of `table`, tombstones included.
 * Within one author `updated_at` is fixed-width hex up to the nodeId suffix, so
 * the lexicographic maximum is the HLC maximum.
 *
 * Index-only on `(node_id, updated_at)`, but still a read of every index entry:
 * neither Postgres nor DSQL skips between groups. On DSQL that read is what a
 * sync tick pays for, so a responder with a peer's watermarks in hand calls
 * {@link readNodeWatermarks} instead, which falls back to this.
 */
export function buildNodeWatermarks(k: Kysely<SinceDb>, table: string): CompiledQuery {
  return k
    .selectFrom(table)
    .select(({ fn }) => ["node_id", fn.max("updated_at").as("max_updated_at")])
    .groupBy("node_id")
    .compile();
}

/**
 * Most authors a floor may name and still be probed in one statement. Each
 * author costs two columns, and Postgres caps a select list at 1,664. A floor
 * wider than this reads every author instead, which is what it cost before.
 */
const MAX_PROBED_AUTHORS = 256;

/**
 * Code-point order, which is byte order under the C collation. DSQL supports
 * only C, so this is the order the gaps between authors are bounded in.
 */
function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return (x.done ? 0 : 1) - (y.done ? 0 : 1);
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

/**
 * The floored watermark read as one statement: for each author in `floor`, its
 * maximum at or above its floor, and for each gap between the floor's authors,
 * the first author in it. One row; `a<i>` and `g<i>` columns.
 */
function buildFlooredNodeWatermarks(
  k: Kysely<SinceDb>,
  table: string,
  authors: readonly string[],
  floor: Record<string, HLCTimestamp>,
): CompiledQuery {
  return k
    .selectNoFrom((eb) => [
      ...authors.map((nodeId, i) =>
        eb
          .selectFrom(table)
          .select(({ fn }) => fn.max("updated_at").as("m"))
          .where("node_id", "=", nodeId)
          .where("updated_at", ">=", serializeHLC(floor[nodeId]!))
          .as(`a${i}`),
      ),
      ...[null, ...authors].map((after, i) => {
        const before = authors[i] ?? null;
        let gap = eb.selectFrom(table).select("node_id");
        if (after !== null) gap = gap.where("node_id", ">", after);
        if (before !== null) gap = gap.where("node_id", "<", before);
        return gap.orderBy("node_id", "asc").limit(1).as(`g${i}`);
      }),
    ])
    .compile();
}

/**
 * This side's per-author watermarks, read relative to a peer's.
 *
 * ## Why a floor
 *
 * A responder reports its coverage watermark every exchange, and on DSQL the
 * grouped read behind it ({@link buildNodeWatermarks}) reads every row the user
 * has in the table. An idle tick changes nothing, yet paid for the whole
 * library, twice per table: once to plan the delta scan and once for the
 * report. DSQL bills by rows read, so that read was most of what the cloud
 * cost (`~/projects/starkeep/findings-dsql-cost-idle-sync-polling-2026-10-28.md`).
 *
 * The peer's watermarks say where to look. Two seeks bounded by them read
 * almost nothing when the two sides agree:
 *
 * - **Each author the floor names:** its maximum among rows at or above its
 *   floor. A seek with no lower bound would not do: DSQL's storage scan reads a
 *   batch ahead of any seek into an author's range, which costs a large author
 *   nearly as much as the grouped read.
 * - **Each gap between the floor's authors:** whether any author lives there.
 *   An empty bounded range reads nothing.
 *
 * ## What comes back
 *
 * Every entry is the author's exact maximum. An author the floor names is
 * omitted when its maximum sits below its floor: that is the one fact the seek
 * cannot price, and the one a caller does not need — {@link planNodeScans}
 * skips such an author, and a coverage union across tables has the value from
 * the table at or above the floor. A caller that needs the omitted values reads
 * again without a floor.
 *
 * An author in a gap is one the peer has never heard of. Its maximum needs the
 * grouped read anyway, so finding one falls back to it, as do an empty floor
 * and one too wide to probe. Those are a new device, a new cloud container and
 * a first sync: rare, and no more expensive than before.
 *
 * Implementations of the watermark methods may ignore the floor and return
 * every author; the contract above allows extra exact entries.
 */
export async function readNodeWatermarks(
  k: Kysely<SinceDb>,
  table: string,
  floor: Record<string, HLCTimestamp> | undefined,
  run: (query: CompiledQuery) => Promise<readonly Record<string, unknown>[]>,
): Promise<Record<string, HLCTimestamp>> {
  const out: Record<string, HLCTimestamp> = {};
  const authors = Object.keys(floor ?? {}).sort(compareCodePoints);
  if (floor && authors.length > 0 && authors.length <= MAX_PROBED_AUTHORS) {
    const [row] = await run(buildFlooredNodeWatermarks(k, table, authors, floor));
    const gapsEmpty = row !== undefined && authors.every((_, i) => row[`g${i}`] == null);
    if (gapsEmpty && row[`g${authors.length}`] == null) {
      authors.forEach((nodeId, i) => {
        const max = row[`a${i}`];
        if (typeof max === "string") out[nodeId] = deserializeHLC(max);
      });
      return out;
    }
  }
  for (const row of await run(buildNodeWatermarks(k, table))) {
    out[row["node_id"] as string] = deserializeHLC(row["max_updated_at"] as string);
  }
  return out;
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
 * comparison is a correct range bound.
 *
 * It is **not** unique within one author, which is the trap. A record carries
 * its own tick, but a batch of labels is stamped with a *single* `clock.now()`
 * shared by every row in it (`sdk.setLabels` and its siblings, up to 3,000 rows
 * per chunk), so a run of rows comparing exactly equal is the normal case here
 * rather than a collision. Ordering is therefore stable but the position within
 * a run is not, and nothing may treat "the last row I read" as a point the
 * author's history can be divided at. {@link collectSince} is what enforces
 * that.
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
 *
 * "Complete up to and including that row" is a claim about a *timestamp*, not
 * about a row, because that is the only unit the receiver's watermark can
 * address. See {@link trimToHlcBoundary}.
 */
export interface SincePage<TRow> {
  readonly rows: TRow[];
  readonly hasMore: boolean;
  readonly truncated: Record<string, HLCTimestamp | null>;
}

/**
 * Cut a truncated page back to a point that is safe to name as a ceiling.
 *
 * A scan stops after N rows, but a ceiling names an HLC, and one author's HLC
 * can cover many rows. Report the last row read as the ceiling when the row
 * after it carries the *same* HLC and the claim is false in the way that loses
 * data permanently: the peer applies the rows it got, lifts its watermark to
 * that HLC, and `selectUnseen` asks for strictly more forever after. The rows
 * on the far side of the split are not deferred, they are unreachable.
 *
 * So this drops every trailing row sharing an HLC with `nextHlc` — the first
 * row the scan did *not* return — leaving a page whose last row ends a complete
 * run. Dropping them costs nothing: the peer's watermark never advances past
 * them, so the next round selects them again from the top.
 *
 * An empty result means the whole page is one timestamp and the caller has not
 * read all of it yet. There is no safe ceiling to report in that case and no
 * amount of trimming produces one — the caller has to widen its read until the
 * run ends, or the author never advances.
 */
export function trimToHlcBoundary<TRow>(
  kept: readonly TRow[],
  nextHlc: HLCTimestamp,
  hlcOf: (row: TRow) => HLCTimestamp,
): TRow[] {
  let end = kept.length;
  while (end > 0 && compareHLC(hlcOf(kept[end - 1]!), nextHlc) === 0) end -= 1;
  return kept.slice(0, end);
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
 *
 * ## The share is a hint, the HLC boundary is not
 *
 * An author's slice can land in the middle of a run of rows sharing one HLC,
 * and a ceiling naming that HLC would be a false claim — see
 * {@link trimToHlcBoundary}. The page is therefore trimmed back to the end of
 * the previous run before its ceiling is reported.
 *
 * When trimming empties the page the entire slice was one timestamp, and no
 * ceiling can be named without reading further. Trimming again would return
 * nothing on every subsequent round too, so that author would never advance.
 * The read widens instead, doubling until the run ends, and the author's page
 * overruns its share by however much that costs. This is the same trade
 * `cutRound` makes when it ships an oversized first group: a timestamp bigger
 * than the budget has to move anyway, because the alternative is a channel that
 * stalls on it permanently.
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
    // Widens only when the slice turns out to be one indivisible timestamp,
    // which is why the common path still issues exactly one query per author.
    for (let window = share; ; window *= 2) {
      const page = await runScan(scan, window);
      if (page.length <= window) {
        // Enumerated completely — no ceiling, and nothing owed for this author.
        rows.push(...page);
        break;
      }
      const kept = trimToHlcBoundary(page.slice(0, window), hlcOf(page[window]!), hlcOf);
      if (kept.length === 0) continue;
      rows.push(...kept);
      truncated[scan.nodeId] = hlcOf(kept[kept.length - 1]!);
      hasMore = true;
      break;
    }
  }
  return { rows, hasMore, truncated };
}
