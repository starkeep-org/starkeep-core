/**
 * The data-gathering half of variant resolution.
 *
 * The decision itself lives in `@starkeep/protocol-primitives`
 * (`resolveVariants`) and is pure. This is what feeds it: the child records of
 * a page, filtered to those carrying the variant label, joined to their
 * dimensions.
 *
 * It lives here rather than in either data server because both need it and the
 * two servers' record routes are otherwise near-copies of each other — a rule
 * kept in both eventually gets fixed in only one. Expressed over the
 * `DatabaseAdapter` interface, so it works against SQLite and DSQL alike.
 *
 * Nothing here names a size class. Resolution is over child records, a label
 * key, and the width/height columns — which is what lets the ladder be
 * respecified without touching the platform.
 */

import {
  resolveVariants,
  typeCategory,
  type ResolvedVariant,
  type StarkeepId,
  type VariantCandidate,
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

export async function loadVariantsForPage(
  db: DatabaseAdapter,
  records: readonly { id: StarkeepId }[],
  variantLabel: { appId: string; key: string },
  targets: readonly number[],
): Promise<Map<StarkeepId, Record<string, ResolvedVariant>>> {
  const out = new Map<StarkeepId, Record<string, ResolvedVariant>>();
  if (records.length === 0 || targets.length === 0) return out;

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
  const candidates = children.records.filter((c) =>
    (labelsByChild.get(c.id) ?? []).some(
      (l) => !l.deletedAt && l.appId === variantLabel.appId && l.key === variantLabel.key,
    ),
  );
  if (candidates.length === 0) return out;

  // Dimensions live in the per-category metadata table, one read per category.
  const dimsById = new Map<StarkeepId, { width: number | null; height: number | null }>();
  const idsByCategory = new Map<string, StarkeepId[]>();
  for (const c of candidates) {
    const category = typeCategory(c.type);
    if (category === "other") continue; // no metadata table, so no dimensions
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

  const byParent = new Map<StarkeepId, VariantCandidate[]>();
  for (const c of candidates) {
    if (!c.parentId) continue;
    const dims = dimsById.get(c.id) ?? { width: null, height: null };
    let list = byParent.get(c.parentId);
    if (!list) byParent.set(c.parentId, (list = []));
    list.push({
      id: c.id,
      objectStorageKey: c.objectStorageKey,
      type: c.type,
      width: dims.width,
      height: dims.height,
    });
  }

  for (const [parentId, list] of byParent) {
    const resolved = resolveVariants(list, targets);
    if (Object.keys(resolved).length > 0) out.set(parentId, resolved);
  }
  return out;
}
