/**
 * Writing a stand-in, or an original's fidelity, planned once for both data
 * servers.
 *
 * The rules live in `@starkeep/protocol-primitives` (`checkStandInWrite`) and
 * are pure. This module gathers what they need through `DatabaseAdapter` — the
 * parent, the parent's live canonical stand-in, the current occupant of the
 * target slot — and turns a refusal into a status and a body. Both servers call
 * it, because a rule kept in both route handlers eventually gets fixed in only
 * one.
 */

import {
  canRead,
  checkOriginalFidelity,
  checkStandInWrite,
  isStandInOriginal,
  stampFor,
  type AccessGrants,
  type DataRecord,
  type HLCClock,
  type StandInRefusal,
  type StandInRole,
  type StandInStandards,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";

/** The error body both servers answer a refused stand-in write with. */
export interface StandInWriteError {
  readonly error: string;
  readonly code: string;
  readonly detail: string;
  /** The live stand-in already holding the slot, on a `StandInExists`. */
  readonly existing?: string;
  /** Every refusal, for a caller fixing several at once. */
  readonly refusals?: readonly StandInRefusal[];
}

export type StandInWritePlan =
  | {
      readonly ok: true;
      readonly role: StandInRole;
      readonly fidelity: number;
      readonly parent: DataRecord;
      /** Write this onto the parent before the stand-in, when not null. */
      readonly recordParentFidelity: number | null;
      /** The stamp to write with `recordParentFidelity`; see `stampFor`. */
      readonly parentStamp: number | null;
      /**
       * True when the stand-in is a canonical one no smaller than its
       * original. Store no stand-in: mark the parent self-canonical instead,
       * with {@link markSelfCanonical}.
       */
      readonly selfCanonical: boolean;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: StandInWriteError;
      /**
       * A fidelity to record on the original even though the stand-in is
       * refused, with {@link recordOriginalFidelity}. Set only for
       * `parent-awaits-stamp`: the cloud stamps an original that carries a
       * fidelity, so keeping the reported value is what lets the retry
       * succeed. See `checkStandInWrite`.
       */
      readonly recordFidelityFirst?: {
        readonly parent: DataRecord;
        readonly fidelity: number;
      };
    };

export interface StandInWriteRequest {
  /** The stand-in's own Starkeep type. */
  readonly type: string;
  readonly parentId: string | null | undefined;
  /** The request's `standIn` field, unparsed: `{ role, fidelity }`. */
  readonly standIn: unknown;
  /** The request's `parentFidelity` field, unparsed. */
  readonly parentFidelity?: unknown;
  /** The stand-in's own size in bytes, from the request. */
  readonly sizeBytes?: unknown;
}

/**
 * Plan a stand-in write.
 *
 * Runs after the servers' own type and write-grant checks, and after their
 * byte-identical dedup, so an idempotent retry of an accepted stand-in never
 * reaches here. Adds the one grant a stand-in needs beyond writing its own
 * type: reading the original it stands in for.
 */
export async function planStandInWrite(
  db: DatabaseAdapter,
  grants: AccessGrants,
  request: StandInWriteRequest,
  standards: StandInStandards,
  knowsLibraryValue: boolean,
): Promise<StandInWritePlan> {
  const standIn = request.standIn;
  if (typeof standIn !== "object" || standIn === null || Array.isArray(standIn)) {
    return refused(400, {
      code: "invalid-stand-in",
      status: 400,
      message: "standIn must be an object: { role, fidelity }",
    });
  }
  const { role, fidelity } = standIn as { role?: unknown; fidelity?: unknown };

  const parentIdGiven = typeof request.parentId === "string" && request.parentId.length > 0;
  const parent = parentIdGiven ? await db.get(request.parentId as StarkeepId) : null;
  const liveParent = parent && !parent.deletedAt ? parent : null;
  if (liveParent && !canRead(grants, liveParent.type)) {
    // The same answer the record routes give for an unreadable record: an app
    // that cannot read the original may not learn it exists by standing in
    // for it.
    return refused(404, {
      code: "parent-not-found",
      status: 404,
      message: "the original this stand-in names does not exist",
    });
  }

  const existingCanonical = liveParent ? await liveStandIn(db, liveParent.id, "canonical") : null;
  const parentStamp = liveParent ? stampFor(liveParent.type, standards, knowsLibraryValue) : null;
  const verdict = checkStandInWrite(
    {
      type: request.type,
      role,
      fidelity,
      parent: liveParent,
      parentIdGiven,
      reportedParentFidelity: request.parentFidelity,
      existingCanonical,
      ...(typeof request.sizeBytes === "number" ? { sizeBytes: request.sizeBytes } : {}),
      parentStamp,
    },
    standards,
  );
  if (verdict.refusals[0]?.code === "canonical-matches" && existingCanonical) {
    return standInExists(existingCanonical.id);
  }
  if (verdict.refusals.length > 0) {
    const first = verdict.refusals[0]!;
    return {
      ok: false,
      status: first.status,
      body: {
        error: "InvalidStandIn",
        code: first.code,
        detail: first.message,
        refusals: verdict.refusals,
      },
      // The original is unstamped, so the stand-in cannot be checked — but the
      // fidelity this write reported is a fact about the file, and keeping it
      // is what lets the cloud stamp the original and the retry succeed.
      ...(first.code === "parent-awaits-stamp" && verdict.recordParentFidelity !== null && liveParent
        ? {
            recordFidelityFirst: {
              parent: liveParent,
              fidelity: verdict.recordParentFidelity,
            },
          }
        : {}),
    };
  }

  // The slot, checked here so the caller learns which stand-in to reuse rather
  // than meeting the unique index. The index still decides a race between two
  // writers that both pass this check. An occupied canonical slot answered
  // above, as `canonical-matches`.
  if (role === "smaller") {
    const occupant = await liveStandIn(db, liveParent!.id, "smaller", fidelity as number);
    if (occupant) return standInExists(occupant.id);
  }

  return {
    ok: true,
    role: role as StandInRole,
    fidelity: fidelity as number,
    parent: liveParent!,
    recordParentFidelity: verdict.recordParentFidelity,
    parentStamp,
    selfCanonical: verdict.selfCanonical,
  };
}

/**
 * Mark an original self-canonical: the platform's answer to a canonical
 * stand-in no smaller than the original. One write records the flag, and the
 * fidelity and stamp when this write is the first to report them.
 */
export async function markSelfCanonical(
  db: DatabaseAdapter,
  plan: Extract<StandInWritePlan, { ok: true }>,
  clock: HLCClock,
): Promise<DataRecord> {
  const updated: DataRecord = {
    ...plan.parent,
    ...(plan.recordParentFidelity !== null ? { fidelity: plan.recordParentFidelity } : {}),
    canonicalThreshold: plan.parent.canonicalThreshold ?? plan.parentStamp,
    selfCanonical: true,
    updatedAt: clock.now(),
    version: plan.parent.version + 1,
  };
  await db.put(updated);
  return updated;
}

/** The 409 for an occupied slot, carrying the stand-in the caller should reuse. */
export function standInExists(existingId: string): {
  readonly ok: false;
  readonly status: 409;
  readonly body: StandInWriteError;
} {
  return {
    ok: false,
    status: 409,
    body: {
      error: "StandInExists",
      code: "stand-in-exists",
      detail:
        "a live stand-in already holds this slot; reuse it rather than producing another",
      existing: existingId,
    },
  };
}

/** Refusals for an original reporting its own `fidelity`, as a status and body. */
export function planOriginalFidelity(request: {
  readonly type: string;
  readonly parentId: string | null | undefined;
  readonly fidelity: unknown;
}):
  | { readonly ok: true; readonly fidelity: number | null }
  | { readonly ok: false; readonly status: number; readonly body: StandInWriteError } {
  const refusals = checkOriginalFidelity({
    type: request.type,
    parentId: request.parentId ?? null,
    fidelity: request.fidelity,
  });
  if (refusals.length > 0) {
    const first = refusals[0]!;
    return {
      ok: false,
      status: first.status,
      body: { error: "InvalidFidelity", code: first.code, detail: first.message, refusals },
    };
  }
  return {
    ok: true,
    fidelity: typeof request.fidelity === "number" ? request.fidelity : null,
  };
}

/**
 * Reconcile a reported fidelity with a record that already exists — the dedup
 * path, where an app registers bytes another app registered first.
 *
 * A record with no fidelity takes the reported one. A record whose fidelity
 * disagrees answers 409, because two apps measuring one file two ways is a bug
 * worth hearing about. Returns the fidelity to write, or null for nothing to
 * do.
 */
export function reconcileReportedFidelity(
  existing: Pick<DataRecord, "fidelity">,
  reported: number | null,
):
  | { readonly ok: true; readonly write: number | null }
  | { readonly ok: false; readonly status: 409; readonly body: StandInWriteError } {
  if (reported === null || existing.fidelity === reported) return { ok: true, write: null };
  if (existing.fidelity === null) return { ok: true, write: reported };
  return {
    ok: false,
    status: 409,
    body: {
      error: "InvalidFidelity",
      code: "fidelity-mismatch",
      detail: `the record's fidelity is recorded as ${existing.fidelity}; this write reports ${reported}`,
    },
  };
}

/**
 * Plan `POST /data/records/:id/fidelity`: an app reporting an existing
 * original's fidelity after the fact.
 *
 * The route exists for the original nothing else would ever describe: one too
 * small to take any stand-in, registered by an app that could not measure it
 * — the folder watcher, say. Without a reported fidelity the platform cannot
 * tell such an original is self-canonical, so every node treats it as above
 * its ceiling and none receives it by default. An app that later decodes it
 * says so here.
 *
 * Gated like a metadata write: the value is a fact derived from the bytes,
 * and the grant that lets an app write a category's facts is the one that
 * lets it report this one. The platform writes the column, so the original
 * keeps its origin.
 */
export async function planFidelityReport(
  db: DatabaseAdapter,
  recordId: string,
  reported: unknown,
  mayReport: (type: string) => boolean,
): Promise<
  | { readonly ok: true; readonly record: DataRecord; readonly write: number | null }
  | { readonly ok: false; readonly status: number; readonly body: StandInWriteError }
> {
  const record = await db.get(recordId as StarkeepId);
  if (!record || record.deletedAt) {
    return refused(404, { code: "not-found", status: 404, message: "Record not found" });
  }
  if (!mayReport(record.type)) {
    return refused(403, {
      code: "forbidden",
      status: 403,
      message: `reporting a fidelity takes a metadataWrite grant on ${record.type}'s category`,
    });
  }
  if (reported === undefined || reported === null) {
    return refused(400, { code: "invalid-fidelity", status: 400, message: "fidelity is required" });
  }
  if (record.standInRole !== null) {
    return refused(400, {
      code: "fidelity-on-stand-in",
      status: 400,
      message: "a stand-in's fidelity is set when it is written; report the original's",
    });
  }
  const checked = planOriginalFidelity({ type: record.type, parentId: record.parentId, fidelity: reported });
  if (!checked.ok) return checked;
  const reconciled = reconcileReportedFidelity(record, checked.fidelity);
  if (!reconciled.ok) return reconciled;
  return { ok: true, record, write: reconciled.write };
}

/**
 * Record an original's fidelity, and stamp it with the threshold it is judged
 * by when it carries no stamp yet.
 *
 * A platform write: the original keeps its `origin_app_id`, and the row moves
 * to a fresh clock so the value reaches every other node. Written before the
 * stand-in that reported it, so a peer applying the two in clock order meets
 * the fidelity first.
 */
export async function recordOriginalFidelity(
  db: DatabaseAdapter,
  original: DataRecord,
  fidelity: number,
  clock: HLCClock,
  stamp: number | null,
): Promise<DataRecord> {
  const updated: DataRecord = {
    ...original,
    fidelity,
    canonicalThreshold: original.canonicalThreshold ?? stamp,
    updatedAt: clock.now(),
    version: original.version + 1,
  };
  await db.put(updated);
  return updated;
}

/**
 * Whether the cloud stamps `record` when it applies it: a live original with a
 * fidelity and no stamp. Only such an original reads the library's value, so
 * the cloud reads its settings for an exchange only when one arrives.
 */
export function awaitsStamp(record: DataRecord): boolean {
  if (record.deletedAt || record.fidelity === null || record.canonicalThreshold !== null) return false;
  return isStandInOriginal(record);
}

/**
 * Stamp the originals among `records` that carry a fidelity and no stamp:
 * the cloud's half of the stamping rule.
 *
 * A node that did not know the library's value recorded such an original's
 * fidelity with a null stamp. The cloud always knows, so it stamps each one it
 * applies, under a fresh cloud clock — which puts the stamped row above the
 * sender's watermark, so the same exchange's reply carries it back. Returns
 * the rows written.
 */
export async function stampUnstampedOriginals(
  db: DatabaseAdapter,
  records: readonly DataRecord[],
  standards: StandInStandards,
  clock: HLCClock,
): Promise<DataRecord[]> {
  const stamped: DataRecord[] = [];
  for (const record of records) {
    if (!awaitsStamp(record)) continue;
    const stamp = stampFor(record.type, standards, true);
    if (stamp === null) continue;
    // Re-read: the row applied may since have been superseded in this store.
    const current = await db.get(record.id as StarkeepId);
    if (!current || current.deletedAt || current.canonicalThreshold !== null) continue;
    const updated: DataRecord = {
      ...current,
      canonicalThreshold: stamp,
      updatedAt: clock.now(),
      version: current.version + 1,
    };
    await db.put(updated);
    stamped.push(updated);
  }
  return stamped;
}

/** The live stand-in in one slot of one original, if any. */
export async function liveStandIn(
  db: DatabaseAdapter,
  parentId: StarkeepId,
  role: StandInRole,
  fidelity?: number,
): Promise<DataRecord | null> {
  const result = await db.query({
    filters: [
      { field: "parentId", operator: "eq", value: parentId },
      { field: "standInRole", operator: "eq", value: role },
      ...(fidelity === undefined
        ? []
        : [{ field: "fidelity", operator: "eq" as const, value: fidelity }]),
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: 1,
  });
  return result.records[0] ?? null;
}

function refused(
  status: number,
  refusal: { code: string; status: number; message: string },
): { readonly ok: false; readonly status: number; readonly body: StandInWriteError } {
  return {
    ok: false,
    status,
    body: { error: "InvalidStandIn", code: refusal.code, detail: refusal.message },
  };
}
