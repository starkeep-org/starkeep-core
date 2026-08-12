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
import {
  pickLadderLabel,
  resolveSizeClass,
  UNCLASSIFIED_RUNG,
  type LadderLabel,
  type SizeClassCensus,
} from "@starkeep/sync-engine";

export interface CensusOptions {
  /**
   * Which label key each installed app uses to name its ladder rungs, keyed by
   * app id. The same map the residency manager resolves classes with — passing
   * one app's key here while the manager reads several would produce a matrix
   * that budgets classes the node never assigns.
   */
  readonly sizeClassKeys: Readonly<Record<string, string>>;
  /**
   * Platform class for a record that is the thing itself.
   *
   * Supplied by the host for the same reason the keys are: "an image record
   * with no parent is an original" is a host rule, and this module does
   * arithmetic without learning what any of it means.
   */
  readonly originalClassFor: (type: string | null) => { qualified: string };
}

interface RecordRow {
  id: string;
  type: string | null;
  size_bytes: number | null;
  parent_id: string | null;
  origin_app_id: string | null;
  label_app_id: string | null;
  label_key: string | null;
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
  // A left join, not an inner one: a record with no rendition label is an
  // *original*, which is the single largest class in any library. Inner-joining
  // would silently drop exactly the rows the retention matrix exists to budget.
  //
  // The join matches **every** installed app's ladder key, not one configured
  // pair, so a second rendition-producing app's rungs show up as their own rows
  // instead of being counted as originals. That means a record can come back
  // more than once; `collapseByRecord` puts it back to one before anything is
  // counted.
  const ladderPairs = Object.entries(options.sizeClassKeys);
  const compiled = qb
    .selectFrom("shared_records as r")
    .leftJoin("shared_record_labels as l", (join) =>
      join
        .onRef("l.record_id", "=", "r.id")
        .on((eb) =>
          // No installed app declares a size-class key: match nothing rather
          // than everything. An empty `or` is `false` in Kysely, but saying so
          // explicitly keeps a future reader from having to know that.
          ladderPairs.length === 0
            ? eb.and([sql<boolean>`1 = 0`])
            : eb.or(
                ladderPairs.map(([appId, key]) =>
                  eb.and([
                    eb("l.app_id", "=", sql.lit(appId)),
                    eb("l.key", "=", sql.lit(key)),
                  ]),
                ),
              ),
        )
        .on("l.deleted_at", "is", null),
    )
    // The two metadata tables used to be joined here for `captured_at`, which
    // fed a per-cutoff cumulative byte count for the recency axis of the
    // retention table. That axis is gone — a hand-written date cutoff was a
    // prediction of what the eviction ordering does anyway — so the census
    // counts what each class contains and nothing about when it was taken.
    .select([
      "r.id as id",
      "r.type as type",
      "r.size_bytes as size_bytes",
      "r.parent_id as parent_id",
      "r.origin_app_id as origin_app_id",
      "l.app_id as label_app_id",
      "l.key as label_key",
      "l.value as size_class",
    ])
    .where("r.deleted_at", "is", null)
    .compile();

  const rows = db.prepare(compiled.sql).all() as unknown as RecordRow[];

  const byClass = new Map<string, MutableCensus>();
  for (const { row, labels } of collapseByRecord(rows)) {
    const sizeClass = classOfRow(row, labels, options);
    const bytes = row.size_bytes ?? 0;
    const entry = byClass.get(sizeClass) ?? blank(sizeClass);
    entry.recordCount += 1;
    entry.totalBytes += bytes;
    byClass.set(sizeClass, entry);
  }

  applyLocalState(db, byClass);
  return [...byClass.values()].map(freeze).sort((a, b) => b.totalBytes - a.totalBytes);
}

interface CensusRecord {
  readonly row: RecordRow;
  readonly labels: LadderLabel[];
}

/**
 * One entry per record, with every ladder label that record carries.
 *
 * The join emits a row per matching label, so a derivative two installed apps
 * have both labelled arrives twice — and counting the joined rows would count
 * the record *and its bytes* into two classes at once. That is the exact
 * over-report the census exists to prevent: it would tell an operator a 1 MiB
 * file costs 2 MiB, and inflate `totalLibraryBytes` with it.
 *
 * Collapsed here rather than in SQL because the tie-break that follows is a
 * rule the residency manager also applies, and it can only be *the same* rule
 * if it is the same code.
 */
function collapseByRecord(rows: readonly RecordRow[]): CensusRecord[] {
  const byRecord = new Map<string, CensusRecord>();
  for (const row of rows) {
    const entry = byRecord.get(row.id) ?? { row, labels: [] };
    if (row.label_app_id !== null && row.label_key !== null && row.size_class !== null) {
      entry.labels.push({ appId: row.label_app_id, key: row.label_key, value: row.size_class });
    }
    byRecord.set(row.id, entry);
  }
  return [...byRecord.values()];
}

/**
 * The class a record counts toward — the census's copy of the residency
 * manager's `resolveClass`, over a row rather than a `BlobCandidate`.
 *
 * The two must agree, because the matrix's whole promise is "this is what
 * saying yes would cost": a census that grouped by different rules would budget
 * classes the node never assigns and miss the ones it does. Same order, same
 * evidence — parent first, then the label's own app, then the record's origin —
 * and where several apps have labelled one record, the same `pickLadderLabel`
 * deciding which of them names the class.
 */
function classOfRow(
  row: RecordRow,
  labels: readonly LadderLabel[],
  options: CensusOptions,
): string {
  if (row.parent_id === null) return options.originalClassFor(row.type).qualified;
  const rung = pickLadderLabel(labels, options.sizeClassKeys, row.origin_app_id);
  if (rung !== undefined) return resolveSizeClass(rung.appId, rung.value).qualified;
  if (row.origin_app_id !== null) {
    return resolveSizeClass(row.origin_app_id, UNCLASSIFIED_RUNG).qualified;
  }
  return options.originalClassFor(row.type).qualified;
}

/**
 * Overlay the one fact only this node knows: what is pinned.
 *
 * Read from the resident set rather than the records table because a pin is
 * node-local — it travels with nothing, and a record carries no trace of one. A
 * census that took it from the shared record would be reporting one device's
 * preferences as if they were the library's.
 *
 * Opened-recently bytes used to be overlaid here too, for the projection's
 * working-set estimate. That estimate existed to guess what a `openedWithinDays`
 * rule would select; the rule is gone, and what a person has opened is now read
 * directly by the eviction ordering rather than being aggregated for a
 * prediction.
 */
function applyLocalState(db: RawDatabase, byClass: Map<string, MutableCensus>): void {
  let rows: Array<{ size_class: string; size_bytes: number; pinned: number }>;
  try {
    rows = db
      .prepare(
        qb
          .selectFrom("resident_blobs")
          .select(["size_class", "size_bytes", "pinned"])
          .compile().sql,
      )
      .all() as never;
  } catch {
    // The resident set is created lazily by the sync engine. A node that has
    // never synced has no such table, and reporting a census without pins is
    // strictly better than failing the whole matrix over it.
    return;
  }

  for (const row of rows) {
    const entry = byClass.get(row.size_class);
    if (!entry) continue;
    if (row.pinned) entry.pinnedBytes += row.size_bytes;
  }
}

interface MutableCensus {
  sizeClass: string;
  recordCount: number;
  totalBytes: number;
  pinnedBytes: number;
}

function blank(sizeClass: string): MutableCensus {
  return { sizeClass, recordCount: 0, totalBytes: 0, pinnedBytes: 0 };
}

function freeze(entry: MutableCensus): SizeClassCensus {
  return {
    sizeClass: entry.sizeClass,
    recordCount: entry.recordCount,
    totalBytes: entry.totalBytes,
    pinnedBytes: entry.pinnedBytes,
  };
}
