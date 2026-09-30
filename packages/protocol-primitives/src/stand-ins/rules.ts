/**
 * The rules built on the stand-in standards: which originals archive, what a
 * stand-in may be, and how a read at a chosen size resolves.
 *
 * Pure, and shared by both data servers and the phone's embedded node, so a
 * rule written here means one thing everywhere. The stores and the servers
 * gather the facts; these functions decide.
 *
 * ## Three kinds of shared record
 *
 * - An **original** is a record in a stand-in category with no parent and no
 *   stand-in role. It is the thing the person added.
 * - A **stand-in** carries a role, `canonical` or `smaller`, and its
 *   `parent_id` always names the original — even when an app derived it from
 *   the canonical stand-in — because readers care what a stand-in replaces,
 *   not how it was made.
 * - A **derived record** has a parent and no role: a poster frame, a skim, a
 *   crop, a Live Photo's motion clip. It cannot replace its parent, so it
 *   never archives, never counts toward a backlog and never takes a stand-in.
 */

import { typeCategory } from "../types/core-types.js";
import {
  isStandInCategory,
  type CategoryStandards,
  type StandInCategory,
  type StandInStandards,
  type SyncDownCeilings,
} from "./standards.js";

export const STAND_IN_ROLES = ["canonical", "smaller"] as const;

/** A stand-in's role. `null` on every record that is not a stand-in. */
export type StandInRole = (typeof STAND_IN_ROLES)[number];

export function isStandInRole(value: unknown): value is StandInRole {
  return typeof value === "string" && (STAND_IN_ROLES as readonly string[]).includes(value);
}

/** The columns every rule here reads off a record. */
export interface StandInFacts {
  readonly id: string;
  readonly type: string;
  readonly parentId: string | null;
  readonly standInRole: StandInRole | null;
  readonly fidelity: number | null;
  readonly sizeBytes: number;
  readonly deletedAt?: unknown;
}

/** Whether a record is an original in the sense this design uses. */
export function isStandInOriginal(record: Pick<StandInFacts, "type" | "parentId" | "standInRole">): boolean {
  return (
    record.parentId === null &&
    record.standInRole === null &&
    isStandInCategory(typeCategory(record.type))
  );
}

export function standardsFor(
  type: string,
  standards: StandInStandards,
): CategoryStandards | null {
  const category = typeCategory(type);
  return isStandInCategory(category) ? standards[category] : null;
}

/**
 * Where an original stands with respect to archiving.
 *
 * - `archivable`: past the size floor, fidelity reported and above the
 *   threshold (or any fidelity, for video). Needs a canonical stand-in and
 *   archives once one exists in the cloud.
 * - `self-canonical`: an image original at or below the threshold, or
 *   at or below the size floor. Takes the canonical stand-in's place
 *   everywhere and never archives.
 * - `video-below-floor`: a video original too small to archive. Video is never
 *   self-canonical, so it still takes a canonical stand-in, and both stay in
 *   the instant tier.
 * - `fidelity-unknown`: nobody has reported the original's fidelity. Never
 *   archives, and every node treats it as above its ceiling.
 */
export type OriginalStatus =
  | "archivable"
  | "self-canonical"
  | "video-below-floor"
  | "fidelity-unknown";

export function originalStatus(
  original: Pick<StandInFacts, "type" | "sizeBytes" | "fidelity">,
  standards: StandInStandards,
): OriginalStatus | null {
  const s = standardsFor(original.type, standards);
  if (!s) return null;
  const belowFloor = original.sizeBytes <= s.sizeFloorBytes;
  if (!s.selfCanonicalAllowed) {
    if (original.fidelity === null) return "fidelity-unknown";
    return belowFloor ? "video-below-floor" : "archivable";
  }
  // Below the floor decides on its own: such an original is not archivable, so
  // it is self-canonical whatever its fidelity turns out to be.
  if (belowFloor) return "self-canonical";
  if (original.fidelity === null) return "fidelity-unknown";
  return original.fidelity > s.canonicalThreshold ? "archivable" : "self-canonical";
}

/** Whether this original takes a canonical stand-in at all. */
export function takesCanonical(status: OriginalStatus | null): boolean {
  return status === "archivable" || status === "video-below-floor";
}

/**
 * The fidelity a canonical stand-in for this original must report.
 *
 * The threshold, except for a video original below it, whose canonical
 * stand-in matches the original's own bitrate. Null when the original takes
 * no canonical stand-in.
 */
export function expectedCanonicalFidelity(
  original: Pick<StandInFacts, "type" | "sizeBytes" | "fidelity">,
  standards: StandInStandards,
): number | null {
  const s = standardsFor(original.type, standards);
  const status = originalStatus(original, standards);
  if (!s || !takesCanonical(status) || original.fidelity === null) return null;
  return Math.min(original.fidelity, s.canonicalThreshold);
}

/**
 * The fidelity that answers every request at or above it: the canonical
 * stand-in's, or the original's own for a self-canonical original.
 *
 * An existing canonical stand-in wins over the expected value, because a
 * canonical stand-in made under an earlier threshold still stands until
 * something replaces it.
 */
export function topFidelity(
  original: Pick<StandInFacts, "type" | "sizeBytes" | "fidelity">,
  canonical: Pick<StandInFacts, "fidelity"> | null,
  standards: StandInStandards,
): number | null {
  const status = originalStatus(original, standards);
  if (status === "self-canonical") return original.fidelity;
  if (canonical?.fidelity != null) return canonical.fidelity;
  return expectedCanonicalFidelity(original, standards);
}

/**
 * The derived unique key the stores index as `(parent_id, stand_in_slot)`.
 *
 * DSQL has no partial indexes, so "one canonical stand-in per original" and
 * "one stand-in per original per size" become one ordinary unique index over a
 * column that is null everywhere those rules do not apply. Null never collides
 * in a unique index on either engine, so ordinary records and tombstones are
 * untouched. A smaller stand-in can never share the canonical stand-in's
 * fidelity, because {@link checkStandInWrite} keeps every smaller fidelity
 * below the canonical one — which is what lets one column carry both rules.
 */
export function standInSlot(
  record: Pick<StandInFacts, "parentId" | "standInRole" | "fidelity"> & { readonly deletedAt?: unknown },
): string | null {
  if (record.deletedAt) return null;
  if (record.parentId === null || record.standInRole === null) return null;
  if (record.standInRole === "canonical") return "canonical";
  return record.fidelity === null ? null : String(record.fidelity);
}

// ---------------------------------------------------------------------------
// Checking a write
// ---------------------------------------------------------------------------

export type StandInRefusalCode =
  | "invalid-role"
  | "invalid-fidelity"
  | "parent-required"
  | "parent-not-found"
  | "parent-is-stand-in"
  | "parent-is-derived"
  | "parent-not-stand-in-category"
  | "type-not-allowed"
  | "parent-fidelity-unknown"
  | "parent-fidelity-mismatch"
  | "original-takes-no-canonical"
  | "canonical-fidelity-wrong"
  | "not-a-standard-size"
  | "exceeds-canonical"
  | "fidelity-on-derived-record"
  | "fidelity-outside-stand-in-category";

export interface StandInRefusal {
  readonly code: StandInRefusalCode;
  /** The HTTP status a server answers with when this is the first refusal. */
  readonly status: 400 | 404 | 409;
  readonly message: string;
}

export interface StandInWriteInput {
  /** The stand-in's own Starkeep type. */
  readonly type: string;
  readonly role: unknown;
  readonly fidelity: unknown;
  /** The parent as stored, or null when no live record has that id. */
  readonly parent: StandInFacts | null;
  readonly parentIdGiven: boolean;
  /** The parent's fidelity as this write reports it, if it reports one. */
  readonly reportedParentFidelity?: unknown;
  /** The parent's live canonical stand-in, if one exists. */
  readonly existingCanonical: Pick<StandInFacts, "id" | "fidelity"> | null;
}

export interface StandInWriteVerdict {
  readonly refusals: readonly StandInRefusal[];
  /**
   * The parent fidelity to record on the parent, when the parent has none and
   * this write reported one. The platform writes it, so no app edits another
   * app's record.
   */
  readonly recordParentFidelity: number | null;
}

/**
 * Every refusal for a proposed stand-in, in the order a caller should fix them.
 *
 * The platform never parses the file. These checks compare reported numbers
 * and declared types, and trust the app for the rest, exactly as the platform
 * already trusts an app with the bytes themselves.
 */
export function checkStandInWrite(
  input: StandInWriteInput,
  standards: StandInStandards,
): StandInWriteVerdict {
  const refusals: StandInRefusal[] = [];
  const refuse = (code: StandInRefusalCode, status: 400 | 404 | 409, message: string) => {
    refusals.push({ code, status, message });
  };
  const none = (): StandInWriteVerdict => ({ refusals, recordParentFidelity: null });

  if (!isStandInRole(input.role)) {
    refuse("invalid-role", 400, `standIn.role must be one of ${STAND_IN_ROLES.join(", ")}`);
  }
  if (!isPositiveInteger(input.fidelity)) {
    refuse("invalid-fidelity", 400, "standIn.fidelity must be a positive integer");
  }
  if (!input.parentIdGiven) {
    refuse("parent-required", 400, "a stand-in names its original in parentId");
    return none();
  }
  const parent = input.parent;
  if (!parent || parent.deletedAt) {
    refuse("parent-not-found", 404, "the original this stand-in names does not exist");
    return none();
  }
  if (parent.standInRole !== null) {
    refuse(
      "parent-is-stand-in",
      400,
      "parentId must name the original, not another stand-in, even when the stand-in was derived from one",
    );
    return none();
  }
  if (parent.parentId !== null) {
    refuse("parent-is-derived", 400, "a derived record cannot take a stand-in; name its original");
    return none();
  }
  const s = standardsFor(parent.type, standards);
  if (!s) {
    refuse(
      "parent-not-stand-in-category",
      400,
      `${parent.type} is outside the stand-in categories (${Object.keys(standards).join(", ")})`,
    );
    return none();
  }
  if (!s.allowedTypes.includes(input.type)) {
    refuse(
      "type-not-allowed",
      400,
      `a ${s.category} stand-in must be ${s.allowedTypes.join(" or ")}, not ${input.type}`,
    );
  }

  // The parent's fidelity: recorded, reported, or both — and when both, equal.
  let parentFidelity = parent.fidelity;
  let recordParentFidelity: number | null = null;
  const reported = input.reportedParentFidelity;
  if (reported !== undefined && reported !== null) {
    if (!isPositiveInteger(reported)) {
      refuse("invalid-fidelity", 400, "parentFidelity must be a positive integer");
    } else if (parentFidelity !== null && parentFidelity !== reported) {
      refuse(
        "parent-fidelity-mismatch",
        409,
        `the original's fidelity is recorded as ${parentFidelity}; this write reports ${reported}`,
      );
    } else if (parentFidelity === null) {
      parentFidelity = reported;
      recordParentFidelity = reported;
    }
  }
  if (parentFidelity === null) {
    refuse(
      "parent-fidelity-unknown",
      400,
      "the original has no reported fidelity; report it as parentFidelity with the first stand-in",
    );
  }
  if (refusals.length > 0) return { refusals, recordParentFidelity: null };

  const role = input.role as StandInRole;
  const fidelity = input.fidelity as number;
  const original = { type: parent.type, sizeBytes: parent.sizeBytes, fidelity: parentFidelity };
  const status = originalStatus(original, standards);

  if (role === "canonical") {
    if (!takesCanonical(status)) {
      refuse(
        "original-takes-no-canonical",
        409,
        "this original is self-canonical: it serves as its own canonical stand-in and never archives",
      );
    } else {
      const expected = expectedCanonicalFidelity(original, standards)!;
      if (fidelity !== expected) {
        refuse(
          "canonical-fidelity-wrong",
          400,
          `the canonical stand-in for this original reports ${expected}, not ${fidelity}`,
        );
      }
    }
  } else {
    if (!s.standardSizes.includes(fidelity)) {
      refuse(
        "not-a-standard-size",
        400,
        `${fidelity} is not a standard ${s.category} size (${s.standardSizes.join(", ")}); ` +
          "a size an app wants for its own purposes is an ordinary derived record",
      );
    }
    const bound = topFidelity(original, input.existingCanonical, standards);
    if (bound !== null && fidelity >= bound) {
      refuse(
        "exceeds-canonical",
        400,
        status === "self-canonical"
          ? `a smaller stand-in must sit below the original's own fidelity (${bound}); the original serves every larger size`
          : `a smaller stand-in must sit below the canonical stand-in's fidelity (${bound})`,
      );
    }
  }

  return { refusals, recordParentFidelity: refusals.length === 0 ? recordParentFidelity : null };
}

/**
 * Refusals for an original, or a derived record, that reports its own
 * fidelity at write.
 *
 * Only an original in a stand-in category carries one. A derived record's
 * fidelity would mean nothing to any rule here, and accepting it would give
 * the column a third reading.
 */
export function checkOriginalFidelity(input: {
  readonly type: string;
  readonly parentId: string | null;
  readonly fidelity: unknown;
}): StandInRefusal[] {
  if (input.fidelity === undefined || input.fidelity === null) return [];
  if (!isPositiveInteger(input.fidelity)) {
    return [{ code: "invalid-fidelity", status: 400, message: "fidelity must be a positive integer" }];
  }
  if (input.parentId !== null) {
    return [
      {
        code: "fidelity-on-derived-record",
        status: 400,
        message: "only an original reports its fidelity; a stand-in reports it in standIn",
      },
    ];
  }
  if (!isStandInCategory(typeCategory(input.type))) {
    return [
      {
        code: "fidelity-outside-stand-in-category",
        status: 400,
        message: `${input.type} is outside the stand-in categories, so it has no fidelity`,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Describing and reading the sizes of one original
// ---------------------------------------------------------------------------

/** Where one size of an original sits, as the node answering sees it. */
export type SizePlacement = "here" | "cloud" | "missing";

export interface StandInSize {
  readonly fidelity: number;
  /** `original` when a self-canonical original answers this size itself. */
  readonly role: StandInRole | "original";
  /** The record that answers this size, or null when none exists yet. */
  readonly recordId: string | null;
  readonly type: string | null;
  readonly objectStorageKey: string | null;
  readonly sizeBytes: number | null;
  readonly placement: SizePlacement;
}

export interface StandInSummary {
  readonly category: StandInCategory;
  readonly fidelity: number | null;
  readonly status: OriginalStatus;
  /** The fidelity that answers every request at or above it. Null when unknown. */
  readonly top: number | null;
  /** Every size that exists or should exist, ascending. */
  readonly sizes: readonly StandInSize[];
  /**
   * Where the original's own bytes sit on the node that answered: `here` or
   * `cloud`. A reader that must not download the original — a background
   * sweep, say — can tell from this alone, since any read of a file the node
   * lacks fetches it.
   */
  readonly originalPlacement: SizePlacement;
}

export interface SummaryStandIn extends StandInFacts {
  readonly objectStorageKey: string;
}

/**
 * The sizes one original has, and where each sits.
 *
 * `placementOf` answers for an existing record — `here` when this node holds
 * the bytes, `cloud` otherwise — because only the node knows. A standard size
 * below the top with no stand-in is `missing`, which is the difference between
 * "not produced yet" and "never applies to this original" that a reader needs
 * to choose a fallback without a second query.
 *
 * A stand-in at a size the standards have since dropped stays listed, because
 * its bytes still exist and still answer a read.
 */
export function summarizeStandIns(
  original: StandInFacts & { readonly objectStorageKey: string },
  standIns: readonly SummaryStandIn[],
  standards: StandInStandards,
  placementOf: (record: { objectStorageKey: string; id: string }) => SizePlacement,
): StandInSummary | null {
  const s = standardsFor(original.type, standards);
  const status = originalStatus(original, standards);
  if (!s || !status || !isStandInOriginal(original)) return null;

  const live = standIns.filter((r) => !r.deletedAt && r.standInRole !== null && r.fidelity !== null);
  const canonical = live.find((r) => r.standInRole === "canonical") ?? null;
  const top = topFidelity(original, canonical, standards);

  const bySize = new Map<number, StandInSize>();
  for (const r of live) {
    if (r.standInRole === "canonical") continue;
    bySize.set(r.fidelity!, sizeOf(r, r.standInRole!, placementOf(r)));
  }
  if (top !== null) {
    for (const size of s.standardSizes) {
      if (size >= top || bySize.has(size)) continue;
      bySize.set(size, missingSize(size, "smaller"));
    }
  }
  if (status === "self-canonical" && original.fidelity !== null) {
    bySize.set(original.fidelity, sizeOf(original, "original", placementOf(original)));
  } else if (canonical) {
    bySize.set(canonical.fidelity!, sizeOf(canonical, "canonical", placementOf(canonical)));
  } else if (top !== null) {
    bySize.set(top, missingSize(top, "canonical"));
  }

  return {
    category: s.category,
    fidelity: original.fidelity,
    status,
    top,
    sizes: [...bySize.values()].sort((a, b) => a.fidelity - b.fidelity),
    originalPlacement: placementOf(original),
  };
}

function sizeOf(
  record: SummaryStandIn,
  role: StandInRole | "original",
  placement: SizePlacement,
): StandInSize {
  return {
    fidelity: record.fidelity!,
    role,
    recordId: record.id,
    type: record.type,
    objectStorageKey: record.objectStorageKey,
    sizeBytes: record.sizeBytes,
    placement,
  };
}

function missingSize(fidelity: number, role: StandInRole): StandInSize {
  return {
    fidelity,
    role,
    recordId: null,
    type: null,
    objectStorageKey: null,
    sizeBytes: null,
    placement: "missing",
  };
}

/** What a read at a chosen size resolves to. */
export type SizeResolution =
  | { readonly kind: "serve"; readonly size: StandInSize }
  | { readonly kind: "not-produced"; readonly fidelity: number }
  | { readonly kind: "not-standard"; readonly message: string }
  | { readonly kind: "unknown-fidelity" };

/**
 * Resolve `size=<n>` or `size=canonical` against one original's summary.
 *
 * - `canonical` answers the canonical stand-in, or the original itself when it
 *   is self-canonical.
 * - A size at or above the top answers the top: the original, or its
 *   canonical stand-in, serves every larger size.
 * - A standard size below the top answers the stand-in at that size, or
 *   `not-produced`. What a reader does then is the node's and the app's call;
 *   this never substitutes a far larger file for a missing small one.
 */
export function resolveSize(
  summary: StandInSummary,
  requested: number | "canonical",
  standards: StandInStandards,
): SizeResolution {
  if (summary.top === null) return { kind: "unknown-fidelity" };
  const top = summary.sizes.find((size) => size.fidelity === summary.top) ?? null;
  if (requested === "canonical" || requested >= summary.top) {
    if (!top || top.placement === "missing") return { kind: "not-produced", fidelity: summary.top };
    return { kind: "serve", size: top };
  }
  const s = standards[summary.category];
  if (!s.standardSizes.includes(requested)) {
    return {
      kind: "not-standard",
      message: `${requested} is not a standard ${summary.category} size (${s.standardSizes.join(", ")}, or canonical)`,
    };
  }
  const exact = summary.sizes.find((size) => size.fidelity === requested);
  if (!exact || exact.placement === "missing") return { kind: "not-produced", fidelity: requested };
  return { kind: "serve", size: exact };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}


// ---------------------------------------------------------------------------
// Residency: where a file sits against a node's ceiling
// ---------------------------------------------------------------------------

/**
 * Where a file sits against a node's sync-down ceiling.
 *
 * A node may go without a file only because a stand-in can take its place, so
 * the ceiling governs exactly the stand-ins and the originals a stand-in can
 * replace — parentless, non-stand-in records whose type has published stand-in
 * standards.
 *
 * - `within`: a stand-in, or a self-canonical original, at or below the
 *   ceiling. The node receives it by default and never removes it.
 * - `above`: every other stand-in or replaceable original — archivable
 *   originals, canonical stand-ins above the ceiling, anything whose fidelity
 *   nobody has reported. Received on demand, removable when the person frees
 *   space.
 * - `keep`: a file no stand-in can replace — a type with no stand-in
 *   standards, or a derived record such as a poster frame. Every node receives
 *   it and keeps it.
 */
export type CeilingPlacement = "within" | "above" | "keep";

export function ceilingPlacement(
  record: Pick<StandInFacts, "type" | "parentId" | "standInRole" | "fidelity" | "sizeBytes">,
  ceilings: SyncDownCeilings,
  standards: StandInStandards,
): CeilingPlacement {
  const s = standardsFor(record.type, standards);
  if (s === null) return "keep";
  const ceiling = ceilings[s.category];
  const fits = (fidelity: number | null) => fidelity !== null && ceiling !== null && fidelity <= ceiling;
  if (record.standInRole !== null) return fits(record.fidelity) ? "within" : "above";
  if (record.parentId !== null) return "keep";
  // An original counts as a stand-in at its own fidelity only when it stands
  // in for itself; an archivable original is always on demand.
  return originalStatus(record, standards) === "self-canonical" && fits(record.fidelity)
    ? "within"
    : "above";
}
