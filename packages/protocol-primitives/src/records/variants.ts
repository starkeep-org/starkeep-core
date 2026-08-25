/**
 * Variant resolution: pick which derived child of a record best answers a
 * request for a target size, expressed in pixels.
 *
 * ## Why consumers ask in pixels and never in class names
 *
 * This is not a convenience wrapper. Derived sizes are per-record *maxima*: a
 * class never upscales, so a class named for 2560 px produces a 900 px file
 * from a 900 px source. A client therefore cannot compute which class it wants
 * — only the server, holding the actual `width`/`height`, can. On top of that,
 * class maxima move (they are the output of a visual test, and can move again
 * on a respec), so every client that hard-codes a class name is a client that
 * has to be found and changed on each of those events, on devices that update
 * on their own schedule.
 *
 * ## The platform does not know what a size class is
 *
 * Nothing in this file names `image-medium` or any other class. Resolution is
 * expressed purely over things the platform already stores: child records, a
 * label key, and the width/height columns. The caller supplies candidates; this
 * decides among them. That is what lets the ladder be respecified without
 * touching the platform, and what lets any image-granted app get the same
 * resolution for free rather than reimplementing it.
 */

import type { StarkeepId } from "../identifiers/types.js";

/** A derived child record eligible to answer a size request. */
export interface VariantCandidate {
  readonly id: StarkeepId;
  readonly objectStorageKey: string;
  /** Canonical Starkeep type of the *variant*, which may differ from its parent's. */
  readonly type: string;
  /** Value of the label that made this child a candidate. */
  readonly labelValue: string;
  /** From the per-category metadata table. Null when not (yet) extracted. */
  readonly width: number | null;
  readonly height: number | null;
}

export interface ResolvedVariant {
  readonly id: StarkeepId;
  readonly objectStorageKey: string;
  readonly type: string;
  readonly width: number;
  readonly height: number;
  /** `max(width, height)` — what the request was expressed in. */
  readonly longEdge: number;
}

/**
 * Resolve one target long edge against a record's variants.
 *
 * 1. The **smallest** variant whose long edge is ≥ the target.
 * 2. If none qualifies, the **largest** variant that exists.
 * 3. **Never the original.** Candidates are derived children only; this never
 *    falls through to the parent, however large the request. Exceeding the
 *    ladder is an explicit restore, never an implicit one — the same guarantee
 *    the storage layer enforces by refusing to thaw an archived object on read.
 *
 * Rule 2 is what lets a client request its full viewport size without knowing
 * whether this particular record even has a rung that large: it gets the best
 * available and can compare the returned dimensions against what it asked for.
 *
 * Candidates with unknown dimensions are excluded rather than guessed at —
 * there is no way to order them, and "largest that exists" is meaningless over
 * a set you cannot order. A record whose variants all lack dimensions resolves
 * to `null`, which reads as "nothing suitable" rather than silently returning
 * an arbitrary one.
 */
export function resolveVariant(
  candidates: readonly VariantCandidate[],
  targetLongEdge: number,
): ResolvedVariant | null {
  const measured = candidates
    .filter(
      (c): c is VariantCandidate & { width: number; height: number } =>
        typeof c.width === "number" &&
        typeof c.height === "number" &&
        c.width > 0 &&
        c.height > 0,
    )
    .map(
      (c): ResolvedVariant => ({
        id: c.id,
        objectStorageKey: c.objectStorageKey,
        type: c.type,
        width: c.width,
        height: c.height,
        longEdge: Math.max(c.width, c.height),
      }),
    );

  if (measured.length === 0) return null;

  // Sorted by long edge, then by id. The id tiebreak is not cosmetic: two
  // variants can legitimately share a long edge (a class that clamped to the
  // source, or a re-derivation mid-supersession), and an unstable choice would
  // hand a different URL to each request — defeating client and edge caching
  // for exactly the records that have the most variants.
  measured.sort((a, b) => a.longEdge - b.longEdge || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const atLeastTarget = measured.find((v) => v.longEdge >= targetLongEdge);
  // Rule 2: clamp to the largest that exists. Deliberately not the parent.
  return atLeastTarget ?? measured[measured.length - 1]!;
}

/**
 * Resolve several targets in one pass, which is what progressive presentation
 * needs — a grid tile and a viewport-sized stage requested together, off the
 * record list that was being fetched anyway.
 *
 * Keyed by the requested target as a string so the caller can look up exactly
 * what it asked for. Targets that resolve to nothing are omitted rather than
 * mapped to null, so "no variants at all" and "no variant for this size" are
 * the same shape — there is no third case, since rule 2 means any target
 * resolves whenever any measured variant exists.
 */
export function resolveVariants(
  candidates: readonly VariantCandidate[],
  targetLongEdges: readonly number[],
): Record<string, ResolvedVariant> {
  const out: Record<string, ResolvedVariant> = {};
  for (const target of targetLongEdges) {
    const resolved = resolveVariant(candidates, target);
    if (resolved) out[String(target)] = resolved;
  }
  return out;
}

/** Upper bound on how many sizes one request may ask for. */
export const MAX_VARIANT_TARGETS = 4;

/**
 * Parse the `variantLongEdge` query parameter: a comma-separated list of
 * positive integers.
 *
 * Rejects rather than coerces. A silently-dropped bad target would serve a
 * plausible-looking wrong size, and the caller — which asked in pixels
 * precisely so it would not have to reason about classes — has no way to
 * notice. The cap exists because each target is a resolution over the same
 * candidate set and an unbounded list is a cheap way to inflate a response.
 */
export function parseVariantLongEdges(
  raw: string,
): { ok: true; targets: number[] } | { ok: false; message: string } {
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    return { ok: false, message: "variantLongEdge must list at least one pixel size" };
  }
  if (parts.length > MAX_VARIANT_TARGETS) {
    return {
      ok: false,
      message: `variantLongEdge accepts at most ${MAX_VARIANT_TARGETS} sizes (got ${parts.length})`,
    };
  }
  const targets: number[] = [];
  for (const part of parts) {
    // Explicitly not parseInt: it accepts "400px" and "12abc", which is the
    // kind of input that comes from string-concatenating a CSS value.
    if (!/^\d+$/.test(part)) {
      return { ok: false, message: `variantLongEdge must be whole pixel sizes (got "${part}")` };
    }
    const value = Number(part);
    if (value <= 0) {
      return { ok: false, message: `variantLongEdge must be positive (got "${part}")` };
    }
    targets.push(value);
  }
  return { ok: true, targets: [...new Set(targets)] };
}
