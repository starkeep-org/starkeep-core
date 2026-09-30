/**
 * The platform's archiving decision.
 *
 * The platform archives an original when three conditions hold:
 *
 *   1. The original is archivable — past the size floor, its fidelity
 *      reported and above the canonical threshold (any fidelity, for video).
 *   2. No app's namespace holds a `do-not-archive` label on it.
 *   3. Its canonical stand-in exists, was made for the threshold the original
 *      is judged by now, and has bytes in the cloud's instant tier. An
 *      original whose canonical stand-in is outdated loses its tag until the
 *      replacement reaches the cloud.
 *
 * "Archives" means tagging the object for the bucket's lifecycle rule, which
 * performs the transition after its hold period. The tag is the whole of the
 * platform's act, so this module decides whether the tag belongs and the
 * caller writes or clears it.
 *
 * Apps no longer take part. The old gate asked an app to assert its ladder was
 * complete; now the stand-in's role and fidelity columns say the same thing in
 * a form the platform can check itself.
 *
 * ## One object, many records
 *
 * Object keys name bytes, so two records holding one file under two names
 * share an object, and tagging it archives both. So every live record on the
 * key has to agree: each an archivable original with its own canonical
 * stand-in in the cloud, none advising against archiving, none kept out of the
 * cloud. One dissenting record keeps the object instant.
 */

import {
  canonicalMatches,
  DO_NOT_ARCHIVE_LABEL_KEY,
  INTENT_TAG_KEY,
  LADDER_TAG_COMPLETE,
  LADDER_TAG_KEY,
  isStandInOriginal,
  originalStatus,
  type DataRecord,
  type RecordLabel,
  type StandInStandards,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { liveStandIn } from "./write.js";

/** The platform's label namespace for record constraints (`starkeep/no-cloud`). */
const PLATFORM_LABEL_APP_ID = "starkeep";
const NO_CLOUD_LABEL_KEY = "no-cloud";

/** Upper bound on records sharing one object; far above any real case. */
const MAX_RECORDS_PER_OBJECT = 100;

export interface ArchiveEvaluation {
  readonly originalId: string;
  /** `archive` when the tag belongs on the object; `keep` otherwise. */
  readonly decision: "archive" | "keep";
  /** Why the object stays instant, one sentence per failed condition. */
  readonly reasons: readonly string[];
  /** The original's object, when it has one. */
  readonly objectStorageKey: string | null;
  /**
   * Whether the original is archivable in itself. A `keep` for an archivable
   * original is one a label or a missing stand-in caused, so a tag already on
   * the object may need clearing; a `keep` for any other original means the
   * object was never a candidate.
   */
  readonly archivable: boolean;
  /** Apps whose namespace holds `do-not-archive` on the original. */
  readonly heldBy: readonly string[];
  /**
   * Whether a record on the object has a canonical stand-in made for another
   * threshold. A restamp is what causes one, and it arrives as an original
   * rather than as a canonical stand-in going away, so this and not the
   * trigger is what lets the tag clear.
   */
  readonly canonicalOutdated: boolean;
}

export async function evaluateArchiving(
  db: DatabaseAdapter,
  storage: Pick<ObjectStorageAdapter, "has">,
  originalId: StarkeepId,
  standards: StandInStandards,
): Promise<ArchiveEvaluation> {
  const keep = (
    reasons: string[],
    extra: Partial<
      Pick<ArchiveEvaluation, "objectStorageKey" | "archivable" | "heldBy" | "canonicalOutdated">
    > = {},
  ): ArchiveEvaluation => ({
    originalId,
    decision: "keep",
    reasons,
    objectStorageKey: extra.objectStorageKey ?? null,
    archivable: extra.archivable ?? false,
    heldBy: extra.heldBy ?? [],
    canonicalOutdated: extra.canonicalOutdated ?? false,
  });

  const original = await db.get(originalId);
  if (!original || original.deletedAt) return keep(["the original does not exist"]);
  if (!isStandInOriginal(original)) return keep(["the record is not an original in a stand-in category"]);
  if (!original.objectStorageKey) return keep(["the original has no file"]);
  const key = original.objectStorageKey;

  // Every live record on this object has to agree — see the module note.
  const sharing = await db.query({
    filters: [
      { field: "objectStorageKey", operator: "eq", value: key },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: MAX_RECORDS_PER_OBJECT,
  });
  const records = sharing.records.length > 0 ? sharing.records : [original];
  const labelsById = await db.getLabelsByRecordIds(records.map((r) => r.id));

  const reasons: string[] = [];
  const heldBy = new Set<string>();
  let archivable = true;
  let canonicalOutdated = false;
  for (const record of records) {
    const verdict = await recordVerdict(db, storage, record, labelsById.get(record.id) ?? [], standards);
    if (!verdict.archivable) archivable = false;
    if (verdict.canonicalOutdated) canonicalOutdated = true;
    for (const app of verdict.heldBy) heldBy.add(app);
    for (const reason of verdict.reasons) {
      reasons.push(record.id === original.id ? reason : `${record.id} shares these bytes: ${reason}`);
    }
  }

  const extra = { objectStorageKey: key, archivable, heldBy: [...heldBy].sort(), canonicalOutdated };
  if (reasons.length > 0) return keep(reasons, extra);
  return { originalId, decision: "archive", reasons: [], ...extra };
}

async function recordVerdict(
  db: DatabaseAdapter,
  storage: Pick<ObjectStorageAdapter, "has">,
  record: DataRecord,
  labels: readonly RecordLabel[],
  standards: StandInStandards,
): Promise<{ archivable: boolean; heldBy: string[]; reasons: string[]; canonicalOutdated: boolean }> {
  const reasons: string[] = [];
  if (!isStandInOriginal(record)) {
    return {
      archivable: false,
      heldBy: [],
      reasons: ["it is not an original in a stand-in category"],
      canonicalOutdated: false,
    };
  }
  const status = originalStatus(record, standards);
  const archivable = status === "archivable";
  if (!archivable) {
    reasons.push(
      status === "fidelity-unknown"
        ? "nobody has reported its fidelity"
        : status === "video-below-floor"
          ? "it is a video below the size floor, which keeps its canonical stand-in and stays instant"
          : record.selfCanonical
            ? "it is self-canonical: no canonical stand-in could be made smaller than it"
            : "it is self-canonical: at or below the threshold or the size floor, it stands in for itself",
    );
  }

  const live = labels.filter((l) => !l.deletedAt);
  const heldBy = live.filter((l) => l.key === DO_NOT_ARCHIVE_LABEL_KEY).map((l) => l.appId);
  if (heldBy.length > 0) reasons.push(`do-not-archive is held by ${[...new Set(heldBy)].sort().join(", ")}`);
  if (live.some((l) => l.appId === PLATFORM_LABEL_APP_ID && l.key === NO_CLOUD_LABEL_KEY)) {
    reasons.push("it is marked starkeep/no-cloud, so the cloud holds no bytes to archive");
  }

  let canonicalOutdated = false;
  if (archivable) {
    const canonical = await liveStandIn(db, record.id, "canonical");
    if (!canonical) {
      reasons.push("it has no canonical stand-in yet");
    } else if (!canonicalMatches(record, canonical, standards)) {
      canonicalOutdated = true;
      reasons.push("its canonical stand-in was made for a different threshold");
    } else if (!canonical.objectStorageKey || !(await storage.has(canonical.objectStorageKey))) {
      reasons.push("its canonical stand-in's bytes are not in the cloud yet");
    }
  }
  return { archivable, heldBy, reasons, canonicalOutdated };
}

/** The tag set that makes the lifecycle rule transition an object. */
export const ARCHIVE_TAGS: Readonly<Record<string, string>> = {
  [INTENT_TAG_KEY]: "archive",
  [LADDER_TAG_KEY]: LADDER_TAG_COMPLETE,
};

export type ArchiveAction = "tagged" | "untagged" | "unchanged";

/**
 * Write or clear the archive tags per an evaluation.
 *
 * `mayUntag` says whether the event behind the evaluation could have *removed*
 * a condition — a `do-not-archive` label arriving, a canonical stand-in going
 * away. Only those clear a tag, so the ordinary run of smaller stand-ins
 * arriving before the canonical one costs no tagging call at all.
 *
 * An object the lifecycle rule has already moved stays where it is: the
 * platform never thaws on its own, and a restore is the person's decision.
 * `isArchived` answers that from the cloud's availability record.
 */
export async function applyArchiveEvaluation(
  storage: Pick<ObjectStorageAdapter, "setTags">,
  evaluation: ArchiveEvaluation,
  options: { readonly mayUntag: boolean; readonly isArchived: (key: string) => Promise<boolean> },
): Promise<ArchiveAction> {
  const key = evaluation.objectStorageKey;
  if (!key || !storage.setTags) return "unchanged";
  if (evaluation.decision === "archive") {
    await storage.setTags(key, { ...ARCHIVE_TAGS });
    return "tagged";
  }
  const mayUntag = options.mayUntag || evaluation.canonicalOutdated;
  if (mayUntag && evaluation.archivable && !(await options.isArchived(key))) {
    // An empty tag set rather than `intent=instant`: the lifecycle rule
    // filters on the archive tags' presence, so an untagged object is
    // structurally ineligible — see `tagsForIntent`.
    await storage.setTags(key, {});
    return "untagged";
  }
  return "unchanged";
}

/** An original an event touched, and whether that event could clear a tag. */
export interface ArchiveTrigger {
  readonly originalId: StarkeepId;
  readonly mayUntag: boolean;
}

/**
 * The originals a batch of written records and labels touches, for
 * re-evaluation.
 *
 * - A canonical stand-in arriving may complete condition 3; one going away
 *   may break it.
 * - An original arriving, or its fidelity arriving, may complete condition 1.
 *   A restamp arrives the same way and may break condition 3, which the
 *   evaluation's `canonicalOutdated` rather than this trigger reports.
 * - A `do-not-archive` label arriving breaks condition 2; its retraction may
 *   complete it.
 *
 * Smaller stand-ins and derived records touch no condition.
 */
export function archiveTriggersFor(
  records: readonly DataRecord[],
  labels: readonly Pick<RecordLabel, "recordId" | "key" | "deletedAt">[],
): ArchiveTrigger[] {
  const byOriginal = new Map<string, boolean>();
  const add = (id: StarkeepId, mayUntag: boolean) => {
    byOriginal.set(id, (byOriginal.get(id) ?? false) || mayUntag);
  };
  for (const record of records) {
    if (record.standInRole === "canonical" && record.parentId) {
      add(record.parentId, Boolean(record.deletedAt));
    } else if (!record.deletedAt && isStandInOriginal(record)) {
      add(record.id, false);
    }
  }
  for (const label of labels) {
    if (label.key !== DO_NOT_ARCHIVE_LABEL_KEY) continue;
    add(label.recordId, !label.deletedAt);
  }
  return [...byOriginal].map(([originalId, mayUntag]) => ({
    originalId: originalId as StarkeepId,
    mayUntag,
  }));
}
