/**
 * Label SQL, built once for both backends.
 *
 * SQLite and DSQL store labels in the same nine columns and answer the same
 * questions about them; before this module each adapter built those queries
 * itself, and the copies drifted only in the ways that are genuinely
 * dialect-specific:
 *
 *   1. **Table name** — `shared_record_labels` vs `shared.record_labels`.
 *   2. **Transaction wrapping** — DSQL wraps everything in `withOccRetry`,
 *      which is the adapter's business, not the query's.
 *
 * Everything left here — the column list, the `ON CONFLICT` update set, the
 * scan cursor, the page-plus-one paging — is one behaviour that must not
 * differ, so it is written once. Each adapter passes in its own compile-only
 * Kysely instance, which is what keeps the dialect's compiler in charge of
 * quoting and parameter binding.
 *
 * ## What is no longer here
 *
 * The **reverse query** — "which records did app A label with key K" — used to
 * be `buildFindByLabel` beside these, with its own cursor and its own null
 * ordering note. It is a parsed query now: see `label-find.ts`, which builds it
 * against the labels schema and runs it through the same compiler every other
 * shared query uses. What survives here is the write path, the forward lookup
 * and the sync-side scan, none of which the grammar expresses.
 */

import type { CompiledQuery, Kysely } from "kysely";
import type { HLCTimestamp, RecordLabel, StarkeepId } from "@starkeep/protocol-primitives";
import { serializeHLC } from "@starkeep/protocol-primitives";
import type { LabelRetraction, LabelUpsert, LabelValueReplacement } from "./types.js";
import { decodeLabelScanCursor, encodeLabelScanCursor } from "./label-cursor.js";
import { labelToRow, rowToLabel, type LabelRow } from "./label-row.js";

/** The dynamic (schema-less) row type both adapters' compilers are built on. */
export type LabelDb = Record<string, Record<string, unknown>>;

/** What actually differs between the two backends. */
export interface LabelDialect {
  /** `"shared_record_labels"` (SQLite) or `"shared.record_labels"` (DSQL). */
  table: string;
}

export const DEFAULT_SCAN_LIMIT = 500;

const PK_COLUMNS = ["record_id", "app_id", "key", "value"] as const;

/** Last write wins for a repeated primary key — see {@link buildLabelUpsert}. */
function dedupeUpserts(labels: LabelUpsert[]): LabelUpsert[] {
  if (labels.length < 2) return labels;
  const byPk = new Map<string, LabelUpsert>();
  // Keyed on the full four-column PK, `value` included: two values of one key
  // are two rows, and collapsing them here would turn a set-valued write into a
  // single-valued one. JSON rather than a joined string because a value is
  // arbitrary caller text, so any separator character can collide.
  for (const l of labels) byPk.set(JSON.stringify([l.recordId, l.appId, l.key, l.value]), l);
  return byPk.size === labels.length ? labels : [...byPk.values()];
}

/**
 * Insert-or-update rows from a **local write**: a fresh HLC on every row, and
 * `deleted_at` cleared so re-setting a retracted label revives it. Without
 * that clear, a set → retract → set cycle writes a row that stays invisible
 * forever.
 *
 * One multi-row statement, never a loop: DSQL caps a transaction at 3,000
 * modified rows and each round trip is billed, so the caller's chunking is
 * what respects the cap.
 *
 * **De-dupes by primary key, last wins**, and does it here rather than trusting
 * callers to. Postgres/DSQL rejects a multi-row `ON CONFLICT DO UPDATE` that
 * touches one row twice (`21000: cannot affect row a second time`) where SQLite
 * quietly applies the last of them — so a repeat that reaches the statement is
 * a batch that passes every offline test and fails only against the cloud.
 * Callers dedupe too ({@link dedupeLabelWrites} in protocol-primitives), because
 * they report a row count; this is the guarantee that no caller can get wrong.
 */
export function buildLabelUpsert(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  labels: LabelUpsert[],
): CompiledQuery {
  return k
    .insertInto(dialect.table)
    .values(
      dedupeUpserts(labels).map((l) => ({
        record_id: l.recordId,
        app_id: l.appId,
        key: l.key,
        value: l.value,
        record_type: l.recordType,
        created_at: serializeHLC(l.hlc),
        updated_at: serializeHLC(l.hlc),
        node_id: l.hlc.nodeId,
        deleted_at: null,
      })),
    )
    .onConflict((oc) =>
      // `value` is a conflict *target* now, not something to update — a differing
      // value is a different row, so there is nothing left for it to overwrite.
      oc.columns([...PK_COLUMNS]).doUpdateSet((eb) => ({
        record_type: eb.ref("excluded.record_type"),
        updated_at: eb.ref("excluded.updated_at"),
        node_id: eb.ref("excluded.node_id"),
        deleted_at: null,
      })),
    )
    .compile();
}

/**
 * The tombstone half of {@link DatabaseAdapter.replaceLabelValues}: retract every
 * value of one `(record, app, key)` **except** the ones being kept.
 *
 * Paired with a {@link buildLabelUpsert} over the kept values, this is how an app
 * that treats a key as single-valued updates it. Without it, re-setting a key
 * leaves the old value beside the new one — the sharpest edge of a set-valued
 * primary key, and one that produces no error.
 *
 * An empty `keep` retracts the key entirely, which is what an app publishing "no
 * names on this photo any more" needs; the `not in ()` that would otherwise
 * compile is avoided by dropping the predicate.
 */
export function buildLabelValueReplacementTombstone(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  r: LabelValueReplacement,
): CompiledQuery {
  let q = k
    .updateTable(dialect.table)
    .set({
      deleted_at: serializeHLC(r.hlc),
      updated_at: serializeHLC(r.hlc),
      node_id: r.hlc.nodeId,
    })
    .where("record_id", "=", r.recordId)
    .where("app_id", "=", r.appId)
    .where("key", "=", r.key)
    // Already-tombstoned rows are skipped so a re-run doesn't restamp them with
    // a later HLC — same reason as the record-delete cascade.
    .where("deleted_at", "is", null);

  if (r.values.length > 0) {
    q = q.where("value", "not in", r.values);
  }
  return q.compile();
}

/**
 * Write a label **snapshot** verbatim — the sync apply path's equivalent of
 * `put(record)`. Every column comes from the incoming row, tombstone included,
 * which is what keeps an inbound retraction retracted;
 * {@link buildLabelUpsert} would clear `deleted_at` and resurrect it.
 */
export function buildLabelSnapshotUpsert(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  label: RecordLabel,
): CompiledQuery {
  const row: LabelRow = labelToRow(label);
  const updateColumns = (Object.keys(row) as Array<keyof LabelRow>).filter(
    (c) => !(PK_COLUMNS as readonly string[]).includes(c),
  );
  return k
    .insertInto(dialect.table)
    .values({ ...row })
    .onConflict((oc) =>
      oc.columns([...PK_COLUMNS]).doUpdateSet((eb) =>
        Object.fromEntries(updateColumns.map((c) => [c, eb.ref(`excluded.${c}`)])),
      ),
    )
    .compile();
}

/**
 * Tombstone a label. Not a DELETE — the retraction itself has to sync.
 *
 * Scoped by the primary key, which contains the server-set `app_id`, so "an app
 * can only retract its own labels" needs no separate check.
 *
 * `value` is optional and its absence is meaningful: **omitted tombstones every
 * value of the key on that record.** A retraction that pinned only the first
 * three PK columns while `value` was in the key would otherwise be the one shape
 * that quietly does nothing when the app has more than one value stored.
 */
export function buildLabelRetraction(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  r: LabelRetraction,
): CompiledQuery {
  let q = k
    .updateTable(dialect.table)
    .set({
      deleted_at: serializeHLC(r.hlc),
      updated_at: serializeHLC(r.hlc),
      node_id: r.hlc.nodeId,
    })
    .where("record_id", "=", r.recordId)
    .where("app_id", "=", r.appId)
    .where("key", "=", r.key);

  if (r.value !== undefined) q = q.where("value", "=", r.value);
  return q.compile();
}

/**
 * Tombstone every label on a record, whatever app wrote it — the record-delete
 * cascade, done in application code because neither backend has a usable FK.
 *
 * Deliberately carries no `app_id` predicate: the record is going away, so
 * every app's assertions about it go with it. Already-tombstoned rows are
 * skipped so a re-run doesn't restamp them with a later HLC.
 */
export function buildTombstoneLabelsForRecord(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  recordId: StarkeepId,
  hlc: HLCTimestamp,
): CompiledQuery {
  return k
    .updateTable(dialect.table)
    .set({
      deleted_at: serializeHLC(hlc),
      updated_at: serializeHLC(hlc),
      node_id: hlc.nodeId,
    })
    .where("record_id", "=", recordId)
    .where("deleted_at", "is", null)
    .compile();
}

/** Forward path: live labels on a page of records, one PK-prefix seek. */
export function buildLabelsByRecordIds(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  recordIds: StarkeepId[],
): CompiledQuery {
  return k
    .selectFrom(dialect.table)
    .selectAll()
    .where("record_id", "in", recordIds)
    .where("deleted_at", "is", null)
    .compile();
}

/** Read one label by primary key, **tombstones included** — the LWW compare. */
export function buildGetLabel(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  recordId: StarkeepId,
  appId: string,
  key: string,
  value: string,
): CompiledQuery {
  return k
    .selectFrom(dialect.table)
    .selectAll()
    .where("record_id", "=", recordId)
    .where("app_id", "=", appId)
    .where("key", "=", key)
    .where("value", "=", value)
    .compile();
}

/**
 * Paginated scan over every label row, **tombstones included**, for the sync
 * outbound scan. Ordered by primary key, with its own cursor: the reverse
 * index's `(value, record_id)` order means something else entirely, and one
 * token type for both would decode into the wrong sort order.
 */
export function buildQueryLabels(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  query: { limit?: number; cursor?: string },
): CompiledQuery {
  const limit = query.limit ?? DEFAULT_SCAN_LIMIT;
  let q = k.selectFrom(dialect.table).selectAll();

  const cursor = query.cursor ? decodeLabelScanCursor(query.cursor) : null;
  if (cursor) {
    // Row-value comparison over all four primary-key columns. `value` must be
    // here: without it the cursor is not unique, and every sibling value of a
    // key after the first would be skipped — losing label rows from the sync
    // stream with nothing to notice, since a short page is not an error.
    q = q.where((eb) =>
      eb.or([
        eb("record_id", ">", cursor.recordId),
        eb.and([eb("record_id", "=", cursor.recordId), eb("app_id", ">", cursor.appId)]),
        eb.and([
          eb("record_id", "=", cursor.recordId),
          eb("app_id", "=", cursor.appId),
          eb("key", ">", cursor.key),
        ]),
        eb.and([
          eb("record_id", "=", cursor.recordId),
          eb("app_id", "=", cursor.appId),
          eb("key", "=", cursor.key),
          eb("value", ">", cursor.value),
        ]),
      ]),
    );
  }

  return q
    .orderBy("record_id", "asc")
    .orderBy("app_id", "asc")
    .orderBy("key", "asc")
    .orderBy("value", "asc")
    .limit(limit + 1)
    .compile();
}

/**
 * Per-nodeId `MAX(updated_at)` over every label row, tombstones included — the
 * label half of the responder's coverage watermark, which is a union over both
 * tables on the Drive channel.
 *
 * Within one node_id group `updated_at` is fixed-width hex up to the nodeId
 * suffix, so a lexicographic MAX equals the HLC MAX. Backed by
 * `(node_id, updated_at)`.
 */
export function buildLabelNodeWatermarks(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
): CompiledQuery {
  return k
    .selectFrom(dialect.table)
    .select(({ fn }) => ["node_id", fn.max("updated_at").as("max_updated_at")])
    .groupBy("node_id")
    .compile();
}

// ---- Shared result shaping -------------------------------------------------

/**
 * Turn the `limit + 1` rows {@link buildQueryLabels} asked for into a page.
 *
 * The extra row is what distinguishes "there is more" from "this was the last
 * page", and `nextCursor` is null in the second case — the only signal a caller
 * may stop on.
 */
export function paginateLabelScan(
  rows: LabelRow[],
  limit = DEFAULT_SCAN_LIMIT,
): { labels: RecordLabel[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map(rowToLabel);
  const last = page[page.length - 1];
  return {
    labels: page,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeLabelScanCursor({
            recordId: last.recordId,
            appId: last.appId,
            key: last.key,
            value: last.value,
          })
        : null,
  };
}

/** Group live labels by record id, the shape `getLabelsByRecordIds` returns. */
export function groupLabelsByRecordId(rows: LabelRow[]): Map<StarkeepId, RecordLabel[]> {
  const result = new Map<StarkeepId, RecordLabel[]>();
  for (const row of rows) {
    const label = rowToLabel(row);
    let list = result.get(label.recordId);
    if (!list) result.set(label.recordId, (list = []));
    list.push(label);
  }
  return result;
}
