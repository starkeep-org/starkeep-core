/**
 * Per-category metadata as a passenger on a synced record.
 *
 * A metadata row is not its own synced entity. It has no HLC, no watermark, and
 * no stream of its own; it rides the record row it belongs to and is applied
 * with it. Three facts make that sound, and all three are properties of the
 * data rather than of this module:
 *
 *   - The relationship is 1:1. `record_id` is the primary key of every
 *     `record_<category>_metadata` table on both backends.
 *   - The bytes are immutable. Object keys are content-addressed and no write
 *     path rewrites `content_hash` or `object_storage_key` on a live record, so
 *     replacing a record's file means a new record.
 *   - The columns are *derived*, never authored — facts anyone re-deriving from
 *     the same file would reproduce (see the note on `IMAGE_METADATA_COLUMNS`).
 *     Anything a person edits lives in app-syncable storage instead.
 *
 * Together those mean two nodes cannot hold conflicting truth about a column,
 * only different amounts of truth. So the merge is a plain overwrite of the
 * columns a snapshot names, and there is nothing to tie-break.
 *
 * ## Absent means "no information", never "no value"
 *
 * Null columns are stripped before sending and dropped on arrival. A node that
 * has only computed `thumb_hash` therefore cannot erase a peer's dimensions,
 * and the payload tracks what is actually known. The cost is one stated
 * limitation: clearing a column back to null is a local operation and does not
 * propagate.
 */

import {
  getCategory,
  typeCategory,
  type MetadataRow,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "./adapter.js";

/** The subset of a record this module needs: which row, and which table. */
export interface MetadataSubject {
  readonly id: StarkeepId;
  readonly type: string;
}

/**
 * The sender's metadata rows for a page of records, keyed by record id, with
 * null columns stripped and `other` records skipped.
 *
 * One `getMetadataByIds` per represented category — one call for a homogeneous
 * page of photos. Records whose row holds nothing but nulls are omitted
 * entirely rather than shipped as a bare `recordId`, which would name no
 * columns and so ask the receiver to write nothing.
 */
export async function loadMetadataForRecords(
  db: Pick<DatabaseAdapter, "getMetadataByIds">,
  records: readonly MetadataSubject[],
): Promise<Map<StarkeepId, MetadataRow>> {
  const out = new Map<StarkeepId, MetadataRow>();
  if (records.length === 0) return out;

  const idsByCategory = new Map<string, StarkeepId[]>();
  for (const r of records) {
    const category = typeCategory(r.type);
    if (category === "other") continue; // no metadata table
    let ids = idsByCategory.get(category);
    if (!ids) idsByCategory.set(category, (ids = []));
    ids.push(r.id);
  }

  for (const [category, ids] of idsByCategory) {
    for (const [id, row] of await db.getMetadataByIds(category, ids)) {
      const wire = toWireColumns(category, row);
      if (wire === null) continue;
      out.set(id, { recordId: id, ...wire });
    }
  }
  return out;
}

/**
 * Apply a snapshot's metadata to the local row, overwriting the columns it
 * names and leaving every other column alone.
 *
 * Must be called **outside** the caller's "local record is at or ahead"
 * guard. An equal or older record row can still carry columns the receiver
 * lacks, and during the migration onto this wire format that is the common
 * case rather than the corner one.
 *
 * Silently does nothing for `other`, for a non-object payload, and for a
 * payload naming no known column. An older peer sends no field at all and a
 * newer one may send columns this build does not know; neither is an error, and
 * a throw here would abort the whole exchange.
 *
 * ## The return value, and why the sender can end up owing nothing but still
 * being owed
 *
 * `true` means this node holds columns the snapshot did not name, so the
 * *sender* is behind on this record and does not know it. The caller answers
 * that by moving the record's clock, which re-ships the merged row.
 *
 * The situation is narrow and it is not hypothetical. A metadata write is only
 * ever visible to sync through the record's clock, so two nodes that each write
 * a different column of the same record each bump that record — and one of
 * those bumps loses the row's LWW. The loser has just merged the winner's
 * columns into a row that is now strictly better than either side's, and no
 * clock anywhere says so. Without this, the union is reachable in one write
 * order and not the other.
 *
 * It cannot flap, which is what separates it from the unconditional bump the
 * design rules out. A bump on every applied row would make each arrival a fresh
 * change to ship back and two nodes would trade one record forever. This fires
 * only while a *named* set is a strict subset of what the receiver holds, and
 * the answer to it is a snapshot naming the union — against which the same test
 * is false on both sides. Nor does it fire for the concurrent same-column case
 * the design deliberately settles as a swap: both sides name the column, so
 * neither is holding anything unnamed.
 *
 * ## Only a requester asks for the answer
 *
 * `detectOwedBack` gates the one extra read this costs, and both callers that
 * pass `false` have a reason.
 *
 * A record this node has never seen cannot have a metadata row worth
 * preserving, so a first sync — the case with thousands of records in it —
 * issues no reads here at all.
 *
 * A **responder** passes `false` unconditionally, and that is a correctness
 * choice rather than a saving. Its answer to being owed something would be to
 * write the merged row under its own clock, which re-authors it — and a
 * responder's coverage report is computed from row authorship, so re-authoring
 * the last row it held from some author erases that author from the report and
 * the requester re-ships that whole author's history every round thereafter. It
 * does not need the mechanism anyway: a responder's reply already carries the
 * merged row whenever its own copy sits above the requester's watermark, and a
 * copy that does not sit above it is one the requester has already received.
 */
export async function applyRecordMetadata(
  db: Pick<DatabaseAdapter, "putMetadata" | "getMetadata">,
  record: MetadataSubject,
  metadata: unknown,
  options: { readonly detectOwedBack: boolean },
): Promise<boolean> {
  const category = typeCategory(record.type);
  if (category === "other") return false;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return false;
  }
  const columns = toWireColumns(category, metadata as Record<string, unknown>);
  if (columns === null) return false;

  let owedBack = false;
  if (options.detectOwedBack) {
    const held = await db.getMetadata(category, record.id);
    if (held !== null) {
      const local = toWireColumns(category, held);
      owedBack =
        local !== null && Object.keys(local).some((name) => !(name in columns));
    }
  }

  await db.putMetadata(category, { recordId: record.id, ...columns });
  return owedBack;
}

/**
 * Drop a record's metadata row, the way a local delete already does.
 *
 * The sync apply path used to leave the row behind on an inbound tombstone
 * while `SdkDataOperations.delete` cascaded, so a deleted record's dimensions
 * outlived it on every peer but the one it was deleted on.
 */
export async function deleteRecordMetadata(
  db: Pick<DatabaseAdapter, "deleteMetadata">,
  record: MetadataSubject,
): Promise<void> {
  const category = typeCategory(record.type);
  if (category === "other") return;
  await db.deleteMetadata(category, record.id);
}

/**
 * The columns of `row` that this build recognizes for `category` and that carry
 * a value, or `null` when that leaves nothing.
 *
 * Filtering against the category's declaration is what keeps a peer's unknown
 * column out of an `INSERT`, where it would throw and take the exchange down
 * with it. Both HTTP metadata routes apply the same check to app writes; this
 * is the same rule on the same table from the other direction.
 *
 * `Date` becomes an ISO string so an in-process round and an HTTP round write
 * the same value — JSON.stringify already does this on the wire, and doing it
 * here means the two transports cannot disagree.
 */
function toWireColumns(
  category: string,
  row: Record<string, unknown>,
): Record<string, unknown> | null {
  const declared = getCategory(category);
  if (!declared || declared.metadataColumns.length === 0) return null;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const column of declared.metadataColumns) {
    const value = row[column.name];
    if (value === null || value === undefined) continue;
    out[column.name] = value instanceof Date ? value.toISOString() : value;
    any = true;
  }
  return any ? out : null;
}
