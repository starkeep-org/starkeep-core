/**
 * Label SQL, built once for both backends.
 *
 * SQLite and DSQL store labels in the same nine columns and answer the same
 * five questions about them; before this module each adapter built those
 * queries itself, and the copies drifted only in the three ways that are
 * genuinely dialect-specific:
 *
 *   1. **Table name** — `shared_record_labels` vs `shared.record_labels`.
 *   2. **Null ordering** — SQLite sorts nulls first in an ASC scan, Postgres
 *      sorts them last, so the reverse query has to spell `NULLS FIRST` out on
 *      one side. See label-cursor.ts for why the normalized order is
 *      nulls-first and why the cursor would otherwise mean two different
 *      things.
 *   3. **Transaction wrapping** — DSQL wraps everything in `withOccRetry`,
 *      which is the adapter's business, not the query's.
 *
 * Everything else — the column list, the `ON CONFLICT` update set, the cursor
 * predicate, the page-plus-one paging — is one behaviour that must not differ,
 * so it is written once. Each adapter passes in its own compile-only Kysely
 * instance, which is what keeps the dialect's compiler in charge of quoting
 * and parameter binding.
 */

import { sql, type CompiledQuery, type Kysely } from "kysely";
import type { HLCTimestamp, RecordLabel, StarkeepId } from "@starkeep/protocol-primitives";
import { serializeHLC } from "@starkeep/protocol-primitives";
import type { FindByLabelQuery, LabelRetraction, LabelUpsert } from "./types.js";
import {
  decodeLabelCursor,
  decodeLabelScanCursor,
  encodeLabelCursor,
  encodeLabelScanCursor,
} from "./label-cursor.js";
import { labelToRow, rowToLabel, type LabelRow } from "./label-row.js";

/** The dynamic (schema-less) row type both adapters' compilers are built on. */
export type LabelDb = Record<string, Record<string, unknown>>;

/** What actually differs between the two backends. */
export interface LabelDialect {
  /** `"shared_record_labels"` (SQLite) or `"shared.record_labels"` (DSQL). */
  table: string;
  /**
   * True when the dialect sorts nulls *last* by default and the reverse
   * query's `NULLS FIRST` therefore has to be written out — Postgres/DSQL.
   * SQLite's ASC is already nulls-first.
   */
  spellOutNullsFirst: boolean;
}

export const DEFAULT_FIND_LIMIT = 50;
export const DEFAULT_SCAN_LIMIT = 500;

const PK_COLUMNS = ["record_id", "app_id", "key"] as const;

/** Last write wins for a repeated primary key — see {@link buildLabelUpsert}. */
function dedupeUpserts(labels: LabelUpsert[]): LabelUpsert[] {
  if (labels.length < 2) return labels;
  const byPk = new Map<string, LabelUpsert>();
  for (const l of labels) byPk.set(`${l.recordId} ${l.appId} ${l.key}`, l);
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
      oc.columns([...PK_COLUMNS]).doUpdateSet((eb) => ({
        value: eb.ref("excluded.value"),
        record_type: eb.ref("excluded.record_type"),
        updated_at: eb.ref("excluded.updated_at"),
        node_id: eb.ref("excluded.node_id"),
        deleted_at: null,
      })),
    )
    .compile();
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
 * Tombstone one label. Not a DELETE — the retraction itself has to sync.
 *
 * Scoped by the full primary key, which contains the server-set `app_id`, so
 * "an app can only retract its own labels" needs no separate check.
 */
export function buildLabelRetraction(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  r: LabelRetraction,
): CompiledQuery {
  return k
    .updateTable(dialect.table)
    .set({
      deleted_at: serializeHLC(r.hlc),
      updated_at: serializeHLC(r.hlc),
      node_id: r.hlc.nodeId,
    })
    .where("record_id", "=", r.recordId)
    .where("app_id", "=", r.appId)
    .where("key", "=", r.key)
    .compile();
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
): CompiledQuery {
  return k
    .selectFrom(dialect.table)
    .selectAll()
    .where("record_id", "=", recordId)
    .where("app_id", "=", appId)
    .where("key", "=", key)
    .compile();
}

/**
 * The reverse query: which records a given app labelled with a given key.
 *
 * Returns `null` when the query cannot match anything — a caller with an empty
 * readable-type set — so both adapters short-circuit identically instead of
 * compiling a `type in ()` that the two dialects disagree about.
 *
 * Fetches `limit + 1` rows so the caller can tell a full page from the last
 * one without a second count.
 */
export function buildFindByLabel(
  k: Kysely<LabelDb>,
  dialect: LabelDialect,
  query: FindByLabelQuery,
): CompiledQuery | null {
  const limit = query.limit ?? DEFAULT_FIND_LIMIT;

  let q = k
    .selectFrom(dialect.table)
    .selectAll()
    .where("app_id", "=", query.appId)
    .where("key", "=", query.key)
    // Pinned by every reverse query — nobody asks for retracted labels — and
    // pinning it is what keeps the tombstone pile out of the scanned range.
    // On DSQL it is the third key column of idx_record_labels_reverse and
    // plans as a scan key: 20 index entries scanned behind 20,000 tombstones,
    // against 20,040 for the same index without it.
    .where("deleted_at", "is", null);

  // Omitted value = presence filter (any value, flags included); supplied =
  // exact match. See FindByLabelQuery.value for why exact-only.
  if (query.value !== undefined) {
    q = q.where("value", "=", query.value);
  }

  // The caller's read grants, applied here rather than after fetching the
  // records, so a page comes back full. `record_type` rides in the reverse
  // index as an INCLUDE payload, which is what makes this an index condition
  // rather than a post-fetch filter.
  if (query.readableTypes !== undefined) {
    const types = [...query.readableTypes];
    if (types.length === 0) return null;
    q = q.where("record_type", "in", types);
  }

  // "Strictly after the cursor", in nulls-first order. Not a row-value
  // comparison: with a NULL on either side that evaluates to NULL rather than
  // false, which silently returns an empty page instead of erroring.
  const cursor = query.cursor ? decodeLabelCursor(query.cursor) : null;
  if (cursor) {
    const { value, recordId } = cursor;
    q =
      value === null
        ? // Nulls sort first, so every non-null value is past the cursor.
          q.where((eb) =>
            eb.or([
              eb("value", "is not", null),
              eb.and([eb("value", "is", null), eb("record_id", ">", recordId)]),
            ]),
          )
        : // Past the nulls entirely — a null can never follow a non-null.
          q.where((eb) =>
            eb.or([
              eb("value", ">", value),
              eb.and([eb("value", "=", value), eb("record_id", ">", recordId)]),
            ]),
          );
  }

  q = dialect.spellOutNullsFirst
    ? q.orderBy(sql`value asc nulls first`)
    : q.orderBy("value", "asc");

  return q.orderBy("record_id", "asc").limit(limit + 1).compile();
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
    // Row-value comparison over the primary key. Safe here — unlike the
    // reverse-index cursor — because all three columns are NOT NULL.
    q = q.where((eb) =>
      eb.or([
        eb("record_id", ">", cursor.recordId),
        eb.and([eb("record_id", "=", cursor.recordId), eb("app_id", ">", cursor.appId)]),
        eb.and([
          eb("record_id", "=", cursor.recordId),
          eb("app_id", "=", cursor.appId),
          eb("key", ">", cursor.key),
        ]),
      ]),
    );
  }

  return q
    .orderBy("record_id", "asc")
    .orderBy("app_id", "asc")
    .orderBy("key", "asc")
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
 * Turn the `limit + 1` rows {@link buildFindByLabel} asked for into a page.
 *
 * The extra row is what distinguishes "there is more" from "this was the
 * last page", and `nextCursor` is null in the second case — which is the only
 * signal a caller may stop on. A *short* page means nothing: an orphaned label
 * (its record deleted in a way that raced sync) drops out above this layer.
 */
export function paginateFindByLabel(
  rows: LabelRow[],
  limit = DEFAULT_FIND_LIMIT,
): { labels: RecordLabel[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const labels = (hasMore ? rows.slice(0, limit) : rows).map(rowToLabel);
  const last = labels[labels.length - 1];
  return {
    labels,
    hasMore,
    nextCursor:
      hasMore && last ? encodeLabelCursor({ value: last.value, recordId: last.recordId }) : null,
  };
}

/** The same, for the primary-key-ordered sync scan. */
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
