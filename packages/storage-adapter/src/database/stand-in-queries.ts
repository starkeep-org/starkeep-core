/**
 * The data-gathering half of the stand-in size summary.
 *
 * `summarizeStandIns` in `@starkeep/protocol-primitives` decides what one
 * original's sizes are; this gathers its inputs for a whole page in one query
 * and asks the host where each file sits. Here rather than in either data
 * server because both need it, expressed over `DatabaseAdapter` so it runs
 * against SQLite and DSQL alike.
 */

import {
  isStandInOriginal,
  summarizeStandIns,
  type DataRecord,
  type SizePlacement,
  type StandInStandards,
  type StandInSummary,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "./adapter.js";

/**
 * Upper bound on stand-ins fetched for one page.
 *
 * A page is at most a few hundred originals and an original has a handful of
 * sizes, so this sits far above any real page. It exists so a pathological
 * original degrades into a truncated summary rather than an unbounded read.
 */
const MAX_STAND_INS_PER_PAGE = 10_000;

/** Every live stand-in of the page's originals, grouped by original. */
export async function loadStandInsForPage(
  db: DatabaseAdapter,
  records: readonly DataRecord[],
): Promise<Map<StarkeepId, DataRecord[]>> {
  const out = new Map<StarkeepId, DataRecord[]>();
  const originals = records.filter((r) => !r.deletedAt && isStandInOriginal(r));
  if (originals.length === 0) return out;
  const result = await db.query({
    filters: [
      { field: "parentId", operator: "in", value: originals.map((r) => r.id) },
      { field: "standInRole", operator: "in", value: ["canonical", "smaller"] },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: MAX_STAND_INS_PER_PAGE,
  });
  for (const standIn of result.records) {
    if (!standIn.parentId) continue;
    let list = out.get(standIn.parentId);
    if (!list) out.set(standIn.parentId, (list = []));
    list.push(standIn);
  }
  return out;
}

/**
 * The size summary of every original on the page, keyed by original id.
 *
 * `placementOf` is the host's answer to "where do these bytes sit": the local
 * server checks its own disk, the cloud answers `cloud`. Asked once per file
 * before any summary is built, because the rule itself is synchronous and the
 * local answer is not.
 */
export async function loadStandInSummariesForPage(
  db: DatabaseAdapter,
  records: readonly DataRecord[],
  standards: StandInStandards,
  placementOf: (record: DataRecord) => Promise<SizePlacement>,
): Promise<Map<StarkeepId, StandInSummary>> {
  const out = new Map<StarkeepId, StandInSummary>();
  const standInsByOriginal = await loadStandInsForPage(db, records);
  const placements = new Map<string, SizePlacement>();
  const toPlace: DataRecord[] = [];
  for (const record of records) {
    if (!isStandInOriginal(record) || record.deletedAt) continue;
    toPlace.push(record, ...(standInsByOriginal.get(record.id) ?? []));
  }
  await Promise.all(
    toPlace.map(async (r) => {
      placements.set(r.id, await placementOf(r));
    }),
  );
  for (const record of records) {
    if (!isStandInOriginal(record) || record.deletedAt) continue;
    const summary = summarizeStandIns(
      record,
      standInsByOriginal.get(record.id) ?? [],
      standards,
      (r) => placements.get(r.id) ?? "cloud",
    );
    if (summary) out.set(record.id, summary);
  }
  return out;
}
