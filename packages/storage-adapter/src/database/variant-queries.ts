/**
 * The derived children of a page of originals, for `?variant=<appId>/<key>`.
 *
 * Every live child carrying the variant label, with its dimensions. It lives
 * here rather than in either data server because both need it and the two
 * servers' record routes are otherwise near-copies of each other — a rule kept
 * in both eventually gets fixed in only one. Expressed over the
 * `DatabaseAdapter` interface, so it works against SQLite and DSQL alike.
 *
 * Nothing here names a size class.
 */

import {
  typeCategory,
  type StarkeepId,
  type VariantCandidate,
  hasMetadataTable,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "./adapter.js";

/**
 * Upper bound on children fetched for one page.
 *
 * A page is at most a few hundred records and a record has a handful of
 * variants, so this is far above any real case; it exists so a pathological
 * record (a record someone attached thousands of children to) degrades into a
 * truncated result rather than an unbounded read.
 */
const MAX_CHILDREN_PER_PAGE = 10_000;

/**
 * Every derived child of the page carrying the label, with its dimensions.
 *
 * Answers one app-agnostic question — *what derived children does this record
 * have, and how big is each one?* — and leaves the choice to the app that owns
 * the label.
 */
export async function loadVariantCandidatesForPage(
  db: DatabaseAdapter,
  records: readonly { id: StarkeepId }[],
  variantLabel: { appId: string; key: string },
): Promise<Map<StarkeepId, VariantCandidate[]>> {
  const out = new Map<StarkeepId, VariantCandidate[]>();
  if (records.length === 0) return out;

  // Every live child of the page in one query. Deliberately not filtered by
  // the label in SQL: a record's children are few, and there is no combined
  // (parent, label) index to make that cheaper than a second pass in memory.
  const children = await db.query({
    filters: [
      { field: "parentId", operator: "in", value: records.map((r) => r.id) },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: MAX_CHILDREN_PER_PAGE,
  });
  if (children.records.length === 0) return out;

  // Only children carrying the variant label are candidates. A crop has a
  // parent too, and serving someone's crop when they asked for a 400 px tile
  // is the bug that reading `parent_id` alone always had.
  const labelsByChild = await db.getLabelsByRecordIds(children.records.map((c) => c.id));
  const labelValueByChild = new Map<StarkeepId, string>();
  const candidates = children.records.filter((c) => {
    const label = (labelsByChild.get(c.id) ?? []).find(
      (l) => !l.deletedAt && l.appId === variantLabel.appId && l.key === variantLabel.key,
    );
    if (!label) return false;
    labelValueByChild.set(c.id, label.value);
    return true;
  });
  if (candidates.length === 0) return out;

  // Dimensions live in the per-category metadata table, one read per category.
  const dimsById = new Map<StarkeepId, { width: number | null; height: number | null }>();
  const idsByCategory = new Map<string, StarkeepId[]>();
  for (const c of candidates) {
    const category = typeCategory(c.type);
    if (!hasMetadataTable(category)) continue; // no metadata table, so no dimensions
    let ids = idsByCategory.get(category);
    if (!ids) idsByCategory.set(category, (ids = []));
    ids.push(c.id);
  }
  for (const [category, ids] of idsByCategory) {
    for (const [id, row] of await db.getMetadataByIds(category, ids)) {
      dimsById.set(id, {
        width: typeof row["width"] === "number" ? row["width"] : null,
        height: typeof row["height"] === "number" ? row["height"] : null,
      });
    }
  }

  for (const c of candidates) {
    if (!c.parentId) continue;
    const dims = dimsById.get(c.id) ?? { width: null, height: null };
    let list = out.get(c.parentId);
    if (!list) out.set(c.parentId, (list = []));
    list.push({
      id: c.id,
      objectStorageKey: c.objectStorageKey,
      type: c.type,
      labelValue: labelValueByChild.get(c.id)!,
      width: dims.width,
      height: dims.height,
    });
  }
  return out;
}
