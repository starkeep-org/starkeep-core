/**
 * "Replace existing canonical stand-ins": applying a changed library threshold
 * to originals already stamped with another one.
 *
 * Replacing means restamping. The stamp is the only thing this writes about
 * most originals; everything else follows from it — the summary marks the
 * outdated canonical stand-in, the backlog counts the original, an app derives
 * a replacement, and the write path swaps the two stand-ins. Two cases need a
 * write beyond the stamp, because only the platform can make them:
 *
 * - **A decrease onto an existing smaller stand-in.** Lowering images to 2560
 *   promotes the 2560 stand-in to canonical with no encode, retiring the old
 *   canonical stand-in and every other smaller one at or above 2560.
 * - **An image raise past the original's own fidelity.** The original now
 *   stands in for itself, so its canonical stand-in, and every smaller one at
 *   or above the original's fidelity, is retired.
 *
 * Each write takes a fresh clock, and a tombstone precedes the stand-in taking
 * its slot, as the stores' slot index requires. The cloud refuses what it must:
 * a raised stamp on an archived original (`vetoRaisedStamp`) and the canonical
 * stand-in of one (`keepCanonicalOfArchivedOriginal`), both shipped back live.
 *
 * See `~/projects/starkeep/plan-canonical-stand-in-setting-2026-09-30.md`,
 * plan choices 2, 8 and 9, and Phase 5.
 */

import {
  isStandInOriginal,
  originalStatus,
  standardsFor,
  typeCategory,
  type DataRecord,
  type HLCClock,
  type StandInCategory,
  type StandInStandards,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import { applyRecordDelete } from "./delete.js";

/** Upper bound on one original's stand-ins; far above any real original. */
const MAX_STAND_INS = 100;

/** What restamping one original wrote. */
export interface RestampResult {
  /** Every row written, stamp first, in the order written. */
  readonly written: readonly DataRecord[];
  /** Whether a smaller stand-in became the canonical one. */
  readonly promoted: boolean;
}

/**
 * The stamp an original takes under new standards: the new threshold for its
 * category. Null when the original is not one a restamp touches — outside the
 * stand-in categories, with no fidelity, unstamped (it already follows the
 * library's value), or stamped with the new value already.
 */
export function restampTarget(original: DataRecord, standards: StandInStandards): number | null {
  if (original.deletedAt || !isStandInOriginal(original) || original.fidelity === null) return null;
  if (original.canonicalThreshold === null) return null;
  const target = standardsFor(original.type, standards)?.canonicalThreshold ?? null;
  return target === original.canonicalThreshold ? null : target;
}

/** Restamp one original, and write what the new stamp makes the platform's to write. */
export async function restampOriginal(
  db: DatabaseAdapter,
  original: DataRecord,
  standards: StandInStandards,
  clock: HLCClock,
): Promise<RestampResult> {
  const target = restampTarget(original, standards);
  if (target === null) return { written: [], promoted: false };
  const fidelity = original.fidelity!;

  const restamped: DataRecord = {
    ...original,
    canonicalThreshold: target,
    // A lower target may make a smaller file possible, so the original stops
    // standing in for itself for want of one. A higher one cannot.
    selfCanonical: original.selfCanonical && target >= fidelity,
    updatedAt: clock.now(),
    version: original.version + 1,
  };
  await db.put(restamped);
  const written: DataRecord[] = [restamped];

  const standIns = await liveStandInsOf(db, original.id as StarkeepId);
  const canonical = standIns.find((r) => r.standInRole === "canonical") ?? null;
  const smaller = standIns.filter((r) => r.standInRole === "smaller");
  const status = originalStatus(restamped, standards);

  if (status === "archivable" && fidelity > target) {
    const atTarget = smaller.find((r) => r.fidelity === target);
    if (atTarget && canonical?.fidelity !== target) {
      // A decrease onto an existing size: that stand-in is the canonical one now.
      const retire = smaller.filter((r) => r.id !== atTarget.id && r.fidelity !== null && r.fidelity >= target);
      if (canonical) written.push(...(await retireAll(db, canonical, retire, clock)));
      else if (retire.length > 0) written.push(...(await retireAll(db, retire[0]!, retire.slice(1), clock)));
      const promoted: DataRecord = {
        ...atTarget,
        standInRole: "canonical",
        updatedAt: clock.now(),
        version: atTarget.version + 1,
      };
      await db.put(promoted);
      written.push(promoted);
      return { written, promoted: true };
    }
  }

  if (status === "self-canonical" && canonical) {
    // A raise past the original's own fidelity: it stands in for itself now.
    const retire = smaller.filter((r) => r.fidelity !== null && r.fidelity >= fidelity);
    written.push(...(await retireAll(db, canonical, retire, clock)));
  }
  return { written, promoted: false };
}

/** What replacing would do to the originals of one category, for the save dialog. */
export interface ReplaceImpact {
  /** Originals stamped with another value, which the replacement restamps. */
  readonly restamp: number;
  /**
   * Originals whose new canonical stand-in an app derives from the original,
   * so the original comes down to a device running the app once. On a raise
   * this is an upper bound: originals the cloud has archived keep their stamp.
   */
  readonly download: { readonly count: number; readonly bytes: number };
  /** Originals whose new canonical stand-in comes from the current one, with no download. */
  readonly fromCanonical: number;
  /** Originals whose new canonical stand-in already exists as a smaller one. */
  readonly promoted: number;
}

/**
 * The impact of replacing under `standards`, by category, over every original
 * the store holds. Pages through the originals; an operator's question, asked
 * before a save, not on every page load.
 */
export async function replaceImpact(
  db: DatabaseAdapter,
  standards: StandInStandards,
  types: readonly string[],
): Promise<Record<StandInCategory, ReplaceImpact>> {
  const tally = {
    image: { restamp: 0, download: { count: 0, bytes: 0 }, fromCanonical: 0, promoted: 0 },
    video: { restamp: 0, download: { count: 0, bytes: 0 }, fromCanonical: 0, promoted: 0 },
  };
  for await (const original of originalsToRestamp(db, standards, types)) {
    const target = restampTarget(original, standards)!;
    const category = typeCategory(original.type) as StandInCategory;
    const t = tally[category];
    t.restamp += 1;
    const fidelity = original.fidelity!;
    const status = originalStatus({ ...original, canonicalThreshold: target, selfCanonical: false }, standards);
    if (status !== "archivable" && status !== "video-below-floor") continue;
    const oldTop = Math.min(fidelity, original.canonicalThreshold!);
    const newTop = Math.min(fidelity, target);
    if (newTop === oldTop) continue;
    const standIns = await liveStandInsOf(db, original.id as StarkeepId);
    const hasCanonical = standIns.some((r) => r.standInRole === "canonical");
    if (standIns.some((r) => r.standInRole === "smaller" && r.fidelity === newTop) && newTop < oldTop) {
      t.promoted += 1;
    } else if (hasCanonical && newTop < oldTop) {
      t.fromCanonical += 1;
    } else {
      t.download.count += 1;
      t.download.bytes += original.sizeBytes;
    }
  }
  return tally;
}

/** Every live original of `types` whose stamp differs from `standards`, a page at a time. */
export async function* originalsToRestamp(
  db: DatabaseAdapter,
  standards: StandInStandards,
  types: readonly string[],
  options: { readonly cursor?: string | null; readonly pageSize?: number } = {},
): AsyncGenerator<DataRecord, void, void> {
  let cursor = options.cursor ?? null;
  do {
    const page = await pageOriginals(db, types, cursor, options.pageSize ?? 500);
    for (const record of page.records) if (restampTarget(record, standards) !== null) yield record;
    cursor = page.nextCursor;
  } while (cursor !== null);
}

/** One page of live, stamped originals of `types`, and the cursor after it. */
export async function pageOriginals(
  db: DatabaseAdapter,
  types: readonly string[],
  cursor: string | null,
  limit: number,
): Promise<{ readonly records: readonly DataRecord[]; readonly nextCursor: string | null }> {
  if (types.length === 0) return { records: [], nextCursor: null };
  const page = await db.query({
    filters: [
      { field: "type", operator: "in", value: [...types] },
      { field: "parentId", operator: "isNull" },
      { field: "standInRole", operator: "isNull" },
      { field: "deletedAt", operator: "isNull" },
      { field: "canonicalThreshold", operator: "isNotNull" },
    ],
    limit,
    ...(cursor ? { cursor } : {}),
  });
  return { records: page.records, nextCursor: page.hasMore ? page.nextCursor : null };
}

/**
 * The cloud's half of a raise on an archived original: refuse the raised stamp.
 *
 * Replacing a canonical stand-in with a larger one needs the original's bytes,
 * and an archived original's bytes need a paid restore the person did not ask
 * for. So the cloud keeps the prior stamp and flag, rewritten under a fresh
 * cloud clock, which puts the row above the sender's watermark: the same
 * exchange's reply carries it back, and the node's restamp dies by ordinary
 * last-writer-wins. Returns the row to store instead of `incoming`, or null to
 * store `incoming` as it is.
 */
export async function vetoRaisedStamp(
  db: DatabaseAdapter,
  current: DataRecord,
  incoming: DataRecord,
  clock: HLCClock,
): Promise<DataRecord | null> {
  if (incoming.deletedAt || current.deletedAt || !isStandInOriginal(incoming)) return null;
  const before = current.canonicalThreshold;
  const after = incoming.canonicalThreshold;
  if (before === null || after === null || after <= before) return null;
  if (!incoming.objectStorageKey) return null;
  const row = (await db.getAvailability([incoming.objectStorageKey])).get(incoming.objectStorageKey);
  if (row?.state !== "archived" && row?.state !== "restoring") return null;
  return {
    ...incoming,
    canonicalThreshold: before,
    selfCanonical: current.selfCanonical,
    updatedAt: clock.now(),
    version: Math.max(incoming.version, current.version) + 1,
  };
}

async function liveStandInsOf(db: DatabaseAdapter, parentId: StarkeepId): Promise<DataRecord[]> {
  const result = await db.query({
    filters: [
      { field: "parentId", operator: "eq", value: parentId },
      { field: "standInRole", operator: "isNotNull" },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: MAX_STAND_INS,
  });
  return result.records;
}

async function retireAll(
  db: DatabaseAdapter,
  first: DataRecord,
  rest: readonly DataRecord[],
  clock: HLCClock,
): Promise<DataRecord[]> {
  return applyRecordDelete(db, { ok: true, record: first, cascade: rest }, clock);
}
