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
    }
  | { readonly ok: false; readonly status: number; readonly body: StandInWriteError };

export interface StandInWriteRequest {
  /** The stand-in's own Starkeep type. */
  readonly type: string;
  readonly parentId: string | null | undefined;
  /** The request's `standIn` field, unparsed: `{ role, fidelity }`. */
  readonly standIn: unknown;
  /** The request's `parentFidelity` field, unparsed. */
  readonly parentFidelity?: unknown;
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
  const verdict = checkStandInWrite(
    {
      type: request.type,
      role,
      fidelity,
      parent: liveParent,
      parentIdGiven,
      reportedParentFidelity: request.parentFidelity,
      existingCanonical,
    },
    standards,
  );
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
    };
  }

  // The slot, checked here so the caller learns which stand-in to reuse rather
  // than meeting the unique index. The index still decides a race between two
  // writers that both pass this check.
  const occupant =
    role === "canonical"
      ? existingCanonical
      : await liveStandIn(db, liveParent!.id, "smaller", fidelity as number);
  if (occupant) return standInExists(occupant.id);

  return {
    ok: true,
    role: role as StandInRole,
    fidelity: fidelity as number,
    parent: liveParent!,
    recordParentFidelity: verdict.recordParentFidelity,
  };
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
 * Record an original's fidelity.
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
): Promise<DataRecord> {
  const updated: DataRecord = {
    ...original,
    fidelity,
    updatedAt: clock.now(),
    version: original.version + 1,
  };
  await db.put(updated);
  return updated;
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
