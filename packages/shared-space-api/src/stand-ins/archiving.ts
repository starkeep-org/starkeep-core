/**
 * The platform's archiving decision.
 *
 * The platform archives an original when three conditions hold:
 *
 *   1. The original is archivable — past the size floor, its fidelity
 *      reported and above the canonical threshold (any fidelity, for video).
 *   2. No app's namespace holds a `do-not-archive` label on it.
 *   3. Its canonical stand-in exists and has bytes in the cloud's instant
 *      tier.
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
}

export async function evaluateArchiving(
  db: DatabaseAdapter,
  storage: Pick<ObjectStorageAdapter, "has">,
  originalId: StarkeepId,
  standards: StandInStandards,
): Promise<ArchiveEvaluation> {
  const keep = (
    reasons: string[],
    extra: Partial<Pick<ArchiveEvaluation, "objectStorageKey" | "archivable" | "heldBy">> = {},
  ): ArchiveEvaluation => ({
    originalId,
    decision: "keep",
    reasons,
    objectStorageKey: extra.objectStorageKey ?? null,
    archivable: extra.archivable ?? false,
    heldBy: extra.heldBy ?? [],
  });

  const original = await db.get(originalId);
  if (!original) return keep(["the original does not exist"]);
  if (!isStandInOriginal(original)) return keep(["the record is not an original in a stand-in category"]);
  if (!original.objectStorageKey) return keep(["the original has no file"]);
  const key = original.objectStorageKey;

  // A deleted original is not an archiving candidate, and the question still has
  // an answer: *may the tag come off*. It may, once no live record shares the
  // object. So the key is kept rather than nulled and `archivable` reports true,
  // which is what `applyArchiveEvaluation` reads before it clears a tag — and
  // nulling the key is what used to make the delete case report `unchanged` and
  // write nothing. A live record sharing the bytes keeps the tag, because the tag
  // is a fact about the object rather than about any one record.
  if (original.deletedAt) {
    const live = await liveRecordsOn(db, key);
    return {
      originalId,
      decision: "keep",
      reasons: ["the original is deleted"],
      objectStorageKey: key,
      archivable: live.length === 0,
      heldBy: [],
    };
  }

  // Every live record on this object has to agree — see the module note.
  const sharing = await liveRecordsOn(db, key);
  const records = sharing.length > 0 ? sharing : [original];
  const labelsById = await db.getLabelsByRecordIds(records.map((r) => r.id));

  const reasons: string[] = [];
  const heldBy = new Set<string>();
  let archivable = true;
  for (const record of records) {
    const verdict = await recordVerdict(db, storage, record, labelsById.get(record.id) ?? [], standards);
    if (!verdict.archivable) archivable = false;
    for (const app of verdict.heldBy) heldBy.add(app);
    for (const reason of verdict.reasons) {
      reasons.push(record.id === original.id ? reason : `${record.id} shares these bytes: ${reason}`);
    }
  }

  const extra = { objectStorageKey: key, archivable, heldBy: [...heldBy].sort() };
  if (reasons.length > 0) return keep(reasons, extra);
  return { originalId, decision: "archive", reasons: [], ...extra };
}

/** The live records sharing one object. Capped — see {@link MAX_RECORDS_PER_OBJECT}. */
async function liveRecordsOn(db: DatabaseAdapter, key: string): Promise<DataRecord[]> {
  const page = await db.query({
    filters: [
      { field: "objectStorageKey", operator: "eq", value: key },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: MAX_RECORDS_PER_OBJECT,
  });
  return [...page.records];
}

async function recordVerdict(
  db: DatabaseAdapter,
  storage: Pick<ObjectStorageAdapter, "has">,
  record: DataRecord,
  labels: readonly RecordLabel[],
  standards: StandInStandards,
): Promise<{ archivable: boolean; heldBy: string[]; reasons: string[] }> {
  const reasons: string[] = [];
  if (!isStandInOriginal(record)) {
    return { archivable: false, heldBy: [], reasons: ["it is not an original in a stand-in category"] };
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

  if (archivable) {
    const canonical = await liveStandIn(db, record.id, "canonical");
    if (!canonical) {
      reasons.push("it has no canonical stand-in yet");
    } else if (!canonical.objectStorageKey || !(await storage.has(canonical.objectStorageKey))) {
      reasons.push("its canonical stand-in's bytes are not in the cloud yet");
    }
  }
  return { archivable, heldBy, reasons };
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
  if (options.mayUntag && evaluation.archivable && !(await options.isArchived(key))) {
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
 * - A `do-not-archive` label arriving breaks condition 2; its retraction may
 *   complete it.
 * - **An original being deleted** removes every condition at once, and the tag
 *   has to come off.
 *
 * Smaller stand-ins and derived records touch no condition.
 *
 * The delete case is the one that was missing, and it is not the same shape as
 * the others. The archive decision is not an operation on a record at all: the
 * platform's whole act is writing two object tags, and the transition is
 * performed later by a bucket lifecycle rule whose clock runs on object age with
 * no view of any record. Delete a record after its object is tagged and before
 * the hold period expires, and the tag outlived the record, the rule fired on
 * schedule, and the bytes landed in Deep Archive owing a 180-day minimum with
 * nothing referencing them. Delete time is the only moment the platform still
 * holds the decision.
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
    } else if (isStandInOriginal(record)) {
      // A tombstoned original emits a trigger with `mayUntag`, which is what
      // takes the tag off an object nothing references any more. Before this it
      // emitted no trigger at all, so the tag outlived the record.
      add(record.id, Boolean(record.deletedAt));
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
