/**
 * Bucketed row counts — how two nodes find out that one of them has lost
 * something, and how a user finds out whether their library is backed up.
 *
 * ## The hole the watermark cannot see
 *
 * A coverage watermark compresses an author's writes into one timestamp, and
 * the contiguous-prefix rule stops a *sender* from ever creating a gap below
 * it. Nothing stops a *receiver* from developing one. If a peer loses a record
 * from the middle of an author's range while keeping a later one, its
 * `MAX(updated_at)` does not move, its coverage report is unchanged, and the
 * sender concludes everything is fine. The record is then unrecoverable through
 * any number of sync rounds.
 *
 * Replace-not-merge on `responderWatermarks` catches losses at the *top* of a
 * range, because those move the maximum. Nothing catches losses in the middle.
 *
 * ## Counts, not checksums
 *
 * A hole means the peer has *fewer* rows in a bucket than we do, so a count
 * detects it. A checksum would only add something when the counts match but the
 * contents differ — the peer having lost one row and gained another *in the same
 * bucket* — which is not how accidental loss happens. Restores lose a tail; bad
 * deletes remove rows; both move the count. (A row the peer holds at an older
 * `updated_at` lands in a different bucket, so both buckets disagree. Still
 * detected.)
 *
 * Leaving the checksum out also removes the only part of this that needed a
 * dialect-specific hash aggregate — Postgres has no built-in XOR over `bytea`,
 * and a modular-sum expression would have had to be validated against DSQL. It
 * can be added later without changing the shape; byte-level corruption is
 * already covered by `durability.ts`'s per-object checksum probes.
 *
 * ## The bucket is a string prefix
 *
 * `updated_at` is `serializeHLC` output — twelve hex digits of wall-clock
 * milliseconds, then the counter, then the nodeId, all zero-padded — so it is
 * lexicographically ordered by time and a time bucket is just a prefix of it.
 * That makes the whole query `GROUP BY node_id, substr(updated_at, 1, N)`,
 * identical on SQLite and DSQL, running off the same `(node_id, updated_at)`
 * index the delta scan uses. No computed column, no `date_trunc`, no timestamp
 * conversion.
 *
 * Buckets are therefore 16^k-millisecond wide rather than calendar-aligned,
 * which does not matter: both sides compute the same prefix, and a bucket is
 * only a unit of comparison. See {@link DEFAULT_BUCKET_PREFIX_LENGTH}.
 */

import type { CompiledQuery, Kysely } from "kysely";
import { sql } from "kysely";
import type { HLCTimestamp } from "@starkeep/protocol-primitives";
import { compareHLC } from "@starkeep/protocol-primitives";

/** Width of the wall-clock field in a serialized HLC — see `serializeHLC`. */
const WALL_TIME_HEX_DIGITS = 12;

/** Widest counter a serialized HLC can carry (four hex digits). */
const MAX_HLC_COUNTER = 0xffff;

/** The dynamic (schema-less) row type both adapters' compilers are built on. */
export type DigestDb = Record<string, Record<string, unknown>>;

/**
 * Hex digits of `updated_at` that define a bucket. Five gives 16^7 ms ≈ **3.1
 * days**.
 *
 * Sized so a decade-long library is ~1,200 buckets — a response of tens of
 * kilobytes, small enough to exchange whole rather than drilling down, and
 * narrow enough that a repair re-ships about three days of writes rather than a
 * library. Shorter prefixes mean wider buckets; the parameter is here so a
 * caller can drill into a disagreeing range later without a redesign.
 */
export const DEFAULT_BUCKET_PREFIX_LENGTH = 5;

/** One author's row count within one time bucket. */
export interface DigestBucket {
  readonly nodeId: string;
  /** The `updated_at` prefix this bucket covers. Opaque; compare, don't parse. */
  readonly bucket: string;
  readonly count: number;
}

export function buildBucketDigest(
  k: Kysely<DigestDb>,
  table: string,
  prefixLength: number,
): CompiledQuery {
  // `substr` is spelled the same in SQLite and Postgres and takes the same
  // 1-based arguments in both.
  const bucket = sql<string>`substr(updated_at, 1, ${sql.lit(prefixLength)})`;
  return k
    .selectFrom(table)
    .select(({ fn }) => [
      "node_id",
      bucket.as("bucket"),
      fn.countAll().as("row_count"),
    ])
    .groupBy(["node_id", bucket])
    .compile();
}

/** Shape a digest query's raw rows. */
export function toDigestBuckets(rows: readonly Record<string, unknown>[]): DigestBucket[] {
  return rows.map((row) => ({
    nodeId: row["node_id"] as string,
    bucket: row["bucket"] as string,
    // Postgres returns COUNT(*) as a bigint, which node-postgres hands back as
    // a string. A cast would typecheck and then compare "12" against 12.
    count: Number(row["row_count"]),
  }));
}

/**
 * Fold two tables' digests into one, summing counts for the same
 * `(author, bucket)`.
 *
 * Records and labels are one channel under one coverage watermark, so a digest
 * over only half of it would report agreement while a label went missing.
 */
export function mergeDigestBuckets(buckets: readonly DigestBucket[]): DigestBucket[] {
  const totals = new Map<string, DigestBucket>();
  for (const b of buckets) {
    const key = bucketKey(b);
    const existing = totals.get(key);
    totals.set(key, existing ? { ...existing, count: existing.count + b.count } : b);
  }
  return [...totals.values()];
}

/**
 * Buckets where the peer holds fewer rows than we do.
 *
 * Deliberately one-directional. A bucket where the *peer* has more than us is
 * not a hole on their side — it is ordinary data we have not pulled yet, and
 * the normal delta scan handles it. Treating it as divergence would make every
 * mid-sync comparison look like corruption.
 */
export function bucketsPeerIsMissing(
  local: readonly DigestBucket[],
  peer: readonly DigestBucket[],
): DigestBucket[] {
  const peerCounts = new Map<string, number>();
  for (const b of peer) peerCounts.set(bucketKey(b), b.count);
  return local.filter((b) => b.count > (peerCounts.get(bucketKey(b)) ?? 0));
}

/**
 * `(nodeId, bucket)` as one map key.
 *
 * The separator is `\u0000` because it is the one character neither field can
 * contain — a nodeId is a ULID and a bucket is a prefix of a serialized HLC —
 * so no pair of distinct buckets can collide on it. Written as an escape and
 * not as a literal NUL: a literal makes the whole file binary as far as git is
 * concerned, and this one had been doing exactly that, so every diff of this
 * file showed up as `Bin 8881 -> 9488` with nothing reviewable in it.
 */
function bucketKey(b: { nodeId: string; bucket: string }): string {
  return `${b.nodeId}\u0000${b.bucket}`;
}

/**
 * The lowest disagreeing bucket per author, as an exclusive HLC floor to
 * re-ship from.
 *
 * Taking the lowest disagreeing bucket rather than repairing each one
 * separately keeps repair to a single monotonic re-ship per author, which is
 * what lets the ordinary delta scan carry it out with no second code path.
 *
 * The returned timestamp sits **just below** the bucket's first possible value,
 * because every scan bound in the system is exclusive (`updated_at > floor`).
 * Returning the bucket start itself would skip a row landing exactly on the
 * boundary — the one row a repair is least able to afford to miss.
 */
export function repairFloorsFor(
  missing: readonly DigestBucket[],
): Record<string, HLCTimestamp> {
  const floors: Record<string, HLCTimestamp> = {};
  for (const b of missing) {
    // The prefix is the leading hex digits of a 12-digit wall-clock reading;
    // padding with zeros gives the earliest millisecond in the bucket.
    const bucketStartMs = parseInt(b.bucket.padEnd(WALL_TIME_HEX_DIGITS, "0"), 16);
    if (!Number.isFinite(bucketStartMs)) continue;
    const floor: HLCTimestamp =
      bucketStartMs <= 0
        ? { wallTime: 0, counter: 0, nodeId: b.nodeId }
        : { wallTime: bucketStartMs - 1, counter: MAX_HLC_COUNTER, nodeId: b.nodeId };
    const existing = floors[b.nodeId];
    if (existing === undefined || compareHLC(floor, existing) < 0) {
      floors[b.nodeId] = floor;
    }
  }
  return floors;
}

/**
 * Lower `watermarks` to `floors` where a repair asks for it.
 *
 * Repair is expressed as data rather than as a branch through the scan: the
 * delta scan takes whatever bound this produces and re-ships from it, with no
 * knowledge that a repair is happening and no second code path through the
 * most safety-critical query in the system.
 *
 * A separate map is required rather than simply lowering `peerWatermarks`,
 * because that field is replaced wholesale by the peer's own report at the end
 * of every round — a local correction to it would be overwritten immediately,
 * by design.
 */
export function applyRepairFloors(
  watermarks: Record<string, HLCTimestamp>,
  floors: Record<string, HLCTimestamp>,
): Record<string, HLCTimestamp> {
  if (Object.keys(floors).length === 0) return watermarks;
  const out = { ...watermarks };
  for (const [nodeId, floor] of Object.entries(floors)) {
    const current = out[nodeId];
    // An author with no watermark takes the floor outright, which on the
    // *inbound* side raises what we advertise: from "nothing at all from this
    // author" to "everything up to `floor`". Sound only because the floors
    // come from `repairFloorsFor`, which returns the **lowest** disagreeing
    // bucket per author — so nothing is owed below it and the claim is one we
    // can actually make. A floor derived any other way (a mid-range bucket, a
    // per-bucket repair) would have this line assert coverage over rows we
    // never received, and the peer would never send them again.
    if (current === undefined || compareHLC(floor, current) < 0) out[nodeId] = floor;
  }
  return out;
}

/**
 * Merge fresh inbound floors into the ones already outstanding, keeping the
 * **higher** of the two per author.
 *
 * The inbound floor is not a fixed mark like its outbound twin — it is a
 * *cursor*. What a node advertises is what the responder scans above, and the
 * node's own watermark cannot move the floor along (it already sits above the
 * hole, which is what made the hole invisible), so the exchange loop climbs the
 * floor to wherever each round's contiguous run reached. Leave it where it is
 * and every round asks for the same range and the repair never gets past its
 * first roundful.
 *
 * {@link applyRepairFloors} takes the *lower* of two values, which is right for
 * lowering a coverage watermark and exactly wrong for merging into a cursor: a
 * `verify()` run during a repair would replace the climbed position with the
 * bottom of the lowest disagreeing bucket again. Pressing "Check backup" twice
 * during a long repair meant the repair never finished.
 *
 * An author with no floor outstanding takes the fresh one outright — that is a
 * repair being armed, not a cursor being reset.
 */
export function raiseInboundFloors(
  outstanding: Record<string, HLCTimestamp>,
  fresh: Record<string, HLCTimestamp>,
): Record<string, HLCTimestamp> {
  const out = { ...outstanding };
  for (const [nodeId, floor] of Object.entries(fresh)) {
    const current = out[nodeId];
    if (current === undefined || compareHLC(floor, current) > 0) out[nodeId] = floor;
  }
  return out;
}

/** Total rows each side holds, for "is my library backed up?". */
export function totalRows(buckets: readonly DigestBucket[]): number {
  return buckets.reduce((sum, b) => sum + b.count, 0);
}
