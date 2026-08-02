/**
 * Counting what the library actually holds, per size class (items 34 and 15).
 *
 * ## Why this lives here and not in the sync engine
 *
 * A size class is a *label value* an app writes, and the platform is not
 * allowed to know what one means — the same rule `decideResidency` follows by
 * taking `sizeClass` as an opaque string the host resolves. So the grouping key
 * comes from a label the host names, and `retention-projection.ts` does
 * arithmetic on the result without ever learning that `image-medium` is a
 * thing.
 *
 * ## Why not from the resident set
 *
 * The resident set is the obvious source and the wrong one: it holds only what
 * this node has *landed*. A census built from it answers "what do I have",
 * while the retention matrix asks "what would this cost me if I said yes" —
 * and the difference is exactly the elided records the operator is deciding
 * about. Counting only what is already local would report every unchecked row
 * as free.
 *
 * So this counts **records**, resident or not, and reads pinned bytes from the
 * resident set separately, since a pin is node-local state that no record
 * carries.
 */

import type { RawDatabase } from "@starkeep/storage-adapter";
import { sqliteCompiler as qb } from "@starkeep/storage-sqlite";
import { sql } from "kysely";
import type { SizeClassCensus } from "@starkeep/sync-engine";

/**
 * Cutoffs the census measures, in days.
 *
 * Fixed rather than derived from the policy, because the matrix is *edited*:
 * an operator dragging a recency window needs the projection to update without
 * a re-query per keystroke. The projection rounds a requested cutoff up to the
 * next measured point, so these bound the resolution of the answer — close
 * enough to be useful, coarse enough that the whole census is one pass.
 */
export const CENSUS_CUTOFF_DAYS: readonly number[] = [7, 30, 90, 180, 365, 730, 1825];

export interface CensusOptions {
  /** The label whose value names a record's size class. */
  readonly classLabel: { appId: string; key: string };
  /**
   * Class assigned to a record carrying no such label — the originals.
   *
   * Supplied by the host for the same reason the label is: "an unlabelled
   * image record is an original" is Photos' rule, not the platform's.
   */
  readonly originalClassFor: (type: string | null) => string;
  readonly nowMs?: number;
}

interface RecordRow {
  id: string;
  type: string | null;
  size_bytes: number | null;
  recency_at_ms: number | null;
  size_class: string | null;
}

/**
 * Build the census in one pass over the records table.
 *
 * One pass, deliberately. The obvious shape — a query per class per cutoff —
 * is `classes × cutoffs` round trips against a table with one row per photo,
 * which on a 60k library is slow enough that the matrix would need a spinner.
 * The accumulation below is linear and happens in memory, where the whole
 * working set is a handful of counters.
 */
export function buildCensus(
  db: RawDatabase,
  options: CensusOptions,
): SizeClassCensus[] {
  const now = options.nowMs ?? Date.now();

  // A left join, not an inner one: a record with no rendition label is an
  // *original*, which is the single largest class in any library. Inner-joining
  // would silently drop exactly the rows the retention matrix exists to budget.
  const compiled = qb
    .selectFrom("shared_records as r")
    .leftJoin("shared_record_labels as l", (join) =>
      join
        .onRef("l.record_id", "=", "r.id")
        .on("l.app_id", "=", sql.lit(options.classLabel.appId))
        .on("l.key", "=", sql.lit(options.classLabel.key))
        .on("l.deleted_at", "is", null),
    )
    .leftJoin("shared_record_image_metadata as im", "im.record_id", "r.id")
    .leftJoin("shared_record_video_metadata as vm", "vm.record_id", "r.id")
    .select([
      "r.id as id",
      "r.type as type",
      "r.size_bytes as size_bytes",
      "l.value as size_class",
      // Capture time only, converted from the stored timestamp to epoch ms.
      //
      // Deliberately **not** falling back to `r.created_at`: that column holds
      // a serialized HLC, not a date, so reading it as a timestamp yields a
      // number that is meaningless and — worse — plausible. `strftime` returns
      // NULL for a NULL or unparseable value, which is exactly the "unknown"
      // this wants: an unknown date must not read as "ancient", or every
      // undated record falls outside every recency window and is quietly
      // marked for eviction. Missing metadata must not become deleted bytes.
      sql<number | null>`CAST(strftime('%s', COALESCE(im.captured_at, vm.captured_at)) AS INTEGER) * 1000`.as(
        "recency_at_ms",
      ),
    ])
    .where("r.deleted_at", "is", null)
    .compile();

  const rows = db.prepare(compiled.sql).all() as unknown as RecordRow[];

  const byClass = new Map<string, MutableCensus>();
  for (const row of rows) {
    const sizeClass = row.size_class ?? options.originalClassFor(row.type);
    const bytes = row.size_bytes ?? 0;
    const entry = byClass.get(sizeClass) ?? blank(sizeClass);
    entry.recordCount += 1;
    entry.totalBytes += bytes;

    const ageDays = ageInDays(row.recency_at_ms, now);
    for (const cutoff of CENSUS_CUTOFF_DAYS) {
      // Cumulative: every record at least as recent as the cutoff counts toward
      // it. `null` age counts toward *every* cutoff, matching the residency
      // rule that an unknown date is not evidence of age.
      if (ageDays === null || ageDays <= cutoff) entry.bytesWithinDays[cutoff] += bytes;
    }
    byClass.set(sizeClass, entry);
  }

  applyLocalState(db, byClass);
  return [...byClass.values()].map(freeze).sort((a, b) => b.totalBytes - a.totalBytes);
}

/**
 * Overlay the two facts only this node knows: what is pinned, and what has been
 * opened recently.
 *
 * Read from the resident set rather than the records table because both are
 * node-local — they travel with nothing, and a record carries no trace of
 * either. A census that took them from the shared record would be reporting one
 * device's habits as if they were the library's.
 */
function applyLocalState(db: RawDatabase, byClass: Map<string, MutableCensus>): void {
  let rows: Array<{ size_class: string; size_bytes: number; pinned: number; last_opened_at_ms: number | null }>;
  try {
    rows = db
      .prepare(
        qb
          .selectFrom("resident_blobs")
          .select(["size_class", "size_bytes", "pinned", "last_opened_at_ms"])
          .compile().sql,
      )
      .all() as never;
  } catch {
    // The resident set is created lazily by the sync engine. A node that has
    // never synced has no such table, and reporting a census without pins is
    // strictly better than failing the whole matrix over it.
    return;
  }

  const now = Date.now();
  for (const row of rows) {
    const entry = byClass.get(row.size_class);
    if (!entry) continue;
    if (row.pinned) entry.pinnedBytes += row.size_bytes;
    if (row.last_opened_at_ms !== null) {
      const days = ageInDays(row.last_opened_at_ms, now);
      for (const cutoff of CENSUS_CUTOFF_DAYS) {
        if (days !== null && days <= cutoff) entry.bytesOpenedWithinDays[cutoff] += row.size_bytes;
      }
    }
  }
}

interface MutableCensus {
  sizeClass: string;
  recordCount: number;
  totalBytes: number;
  bytesWithinDays: Record<number, number>;
  bytesOpenedWithinDays: Record<number, number>;
  pinnedBytes: number;
}

function blank(sizeClass: string): MutableCensus {
  const zeroed = () => Object.fromEntries(CENSUS_CUTOFF_DAYS.map((d) => [d, 0]));
  return {
    sizeClass,
    recordCount: 0,
    totalBytes: 0,
    bytesWithinDays: zeroed(),
    bytesOpenedWithinDays: zeroed(),
    pinnedBytes: 0,
  };
}

function freeze(entry: MutableCensus): SizeClassCensus {
  return {
    sizeClass: entry.sizeClass,
    recordCount: entry.recordCount,
    totalBytes: entry.totalBytes,
    bytesWithinDays: entry.bytesWithinDays,
    bytesOpenedWithinDays: entry.bytesOpenedWithinDays,
    pinnedBytes: entry.pinnedBytes,
  };
}

/**
 * Age in whole days, or `null` when the record carries no usable date.
 *
 * `null` rather than a large number on purpose. Treating an unknown date as
 * ancient would place every undated record outside every recency window, which
 * marks it for eviction — turning missing metadata into deleted bytes.
 */
export function ageInDays(atMs: number | null, nowMs: number): number | null {
  if (atMs === null || !Number.isFinite(atMs)) return null;
  return Math.max(0, (nowMs - atMs) / 86_400_000);
}
