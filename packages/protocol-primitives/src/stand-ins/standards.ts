/**
 * The stand-in standards the platform publishes, per stand-in category.
 *
 * A stand-in is a lower-fidelity file that can replace an original for the
 * person — a screen-sized AVIF for a 50 MB raw file, a 1080p WebM for a 4K
 * clip. Apps produce stand-ins; the platform decides what counts as one, and
 * this module is where that decision is written down. See
 * `~/projects/starkeep/exploration-shared-forms-generator-2026-09-27.md`.
 *
 * ## Why the platform owns these numbers
 *
 * Archiving and residency both ask whether a large-enough stand-in exists, and
 * an app can reuse another app's stand-in only when both describe fidelity the
 * same way. So the fidelity axis, the allowed formats, the minimum quality, the
 * canonical threshold and the standard sizes are one vocabulary for every app,
 * and a new category or a changed standard is a platform release.
 *
 * ## Standards never rank stand-ins
 *
 * The fidelity value alone identifies and ranks a stand-in. The minimum
 * quality and the allowed formats are rules every stand-in meets, not a second
 * axis: a second axis would make fidelity a partial order, and "the largest
 * stand-in" and "at least 640 pixels" both need a total one.
 *
 * ## Defaults, passed as a parameter
 *
 * The person may eventually change the canonical threshold and the standard
 * sizes. Every rule in `rules.ts` therefore takes the standards as an argument
 * rather than reading this constant, so a later settings store swaps the
 * source without touching a rule.
 */

import type { Category } from "../types/core-types.js";

/**
 * The media categories that support stand-ins.
 *
 * Audio is not one, though a stand-in could replace an audio file in
 * principle: no app derives audio stand-ins, and a category with standards but
 * no deriver would keep every audio file off every node with nothing to stand
 * in for it. Audio returns here together with the app that fills it.
 */
export const STAND_IN_CATEGORIES = ["image", "video"] as const;

export type StandInCategory = (typeof STAND_IN_CATEGORIES)[number];

export function isStandInCategory(category: Category | string): category is StandInCategory {
  return (STAND_IN_CATEGORIES as readonly string[]).includes(category);
}

/**
 * What a category's fidelity value measures.
 *
 * - Images use the long edge in pixels rather than a vertical resolution, so a
 *   portrait photo and a landscape one rank the same.
 * - Video uses the bitrate in kbps, over the whole container, audio included.
 *   Bitrate decides a clip's quality and size far more than resolution does,
 *   so resolution is an advisory encoder setting beside it
 *   ({@link CategoryStandards.advisoryLongEdges}) rather than the measure.
 *
 * On an original the value is measured: the long edge, or the file's size in
 * bits over its duration. On a stand-in the value is what the app asked the
 * encoder for. A video encoder lands near its target bitrate, not on it — a
 * 4800 kbps target measuring 4782 kbps is the ordinary case — and a measured
 * value would almost never equal the fidelity an original expects of its
 * canonical stand-in. The target therefore names the standard a stand-in was
 * made to, and the stand-in's byte size, which is exact, guards against an
 * encode that outgrows its original.
 */
export type FidelityAxis = "long-edge-px" | "kbps";

/**
 * The largest long edge an app should encode each stand-in size at, for a
 * category whose fidelity is not itself a long edge.
 *
 * Advisory: the platform never parses media and stand-ins carry no metadata
 * row, so nothing checks it, and no rule reads it. Changing one changes the
 * stand-ins encoded afterward and nothing else — no stand-in becomes outdated
 * and no original changes status. An app never encodes above the original's
 * own long edge, whatever this says.
 */
export interface AdvisoryLongEdges {
  /** For the canonical stand-in. */
  readonly canonical: number;
  /** For each standard size, keyed by the size's fidelity. */
  readonly bySize: Readonly<Record<number, number>>;
}

/** The minimum encoder setting, on the codec's own scale. */
export interface MinimumQuality {
  /** The encoder setting the number refers to, for people reading the standard. */
  readonly setting: string;
  readonly value: number;
  /** Whether a higher value means better quality (AVIF) or worse (VP9 CRF). */
  readonly higherIsBetter: boolean;
}

export interface CategoryStandards {
  readonly category: StandInCategory;
  readonly fidelityAxis: FidelityAxis;
  /**
   * The Starkeep types a stand-in in this category may take. One codec per
   * category, because quality settings and bitrates do not compare across
   * codecs: AVIF at quality 60 and JPEG at quality 60 are different pictures.
   */
  readonly allowedTypes: readonly string[];
  /** Null when the category sets no minimum. */
  readonly minimumQuality: MinimumQuality | null;
  /**
   * The fidelity of the canonical stand-in, and the line between an original
   * that archives behind one and an original that stands in for itself.
   */
  readonly canonicalThreshold: number;
  /**
   * The sizes a smaller stand-in may take, ascending. Every one sits below the
   * canonical threshold, so a new size can always be derived from the
   * canonical stand-in without a thaw.
   */
  readonly standardSizes: readonly number[];
  /**
   * Originals at or below this many bytes never archive. Deep Archive bills a
   * 40 KB per-object overhead and a 180-day minimum, so a small object frozen
   * is dearer and slower to read at once.
   */
  readonly sizeFloorBytes: number;
  /**
   * Whether an original at or below the threshold stands in for itself by
   * that fact alone. False for video: a clip below the threshold still takes
   * a canonical stand-in at its own bitrate, because VP9 usually carries the
   * same picture in fewer bytes and plays in every browser.
   */
  readonly selfCanonicalAllowed: boolean;
  /** Null for a category whose fidelity is already a long edge. */
  readonly advisoryLongEdges: AdvisoryLongEdges | null;
}

export type StandInStandards = Readonly<Record<StandInCategory, CategoryStandards>>;

/**
 * Below this, archiving costs more than not archiving. The same number the
 * lifecycle rule's `objectSizeGreaterThan` carries.
 */
export const ARCHIVE_SIZE_FLOOR_BYTES = 1024 * 1024;

export const DEFAULT_STAND_IN_STANDARDS: StandInStandards = {
  image: {
    category: "image",
    fidelityAxis: "long-edge-px",
    allowedTypes: ["image/avif"],
    minimumQuality: { setting: "AVIF quality (libavif / sharp scale)", value: 60, higherIsBetter: true },
    // The size Photos calls `image-large`: a 4K television, a retina laptop
    // at fullscreen, zoom and print preview.
    canonicalThreshold: 4272,
    standardSizes: [320, 640, 1280, 2560],
    sizeFloorBytes: ARCHIVE_SIZE_FLOOR_BYTES,
    selfCanonicalAllowed: true,
    advisoryLongEdges: null,
  },
  video: {
    category: "video",
    fidelityAxis: "kbps",
    allowedTypes: ["video/webm"],
    minimumQuality: {
      setting: "libvpx-vp9 constrained quality: CRF, with the target bitrate as -b:v",
      value: 31,
      higherIsBetter: false,
    },
    canonicalThreshold: 4800,
    standardSizes: [2000],
    sizeFloorBytes: ARCHIVE_SIZE_FLOOR_BYTES,
    selfCanonicalAllowed: false,
    // 1080p and 720p, in either orientation.
    advisoryLongEdges: { canonical: 1920, bySize: { 2000: 1280 } },
  },
};

/**
 * The MIME type each allowed stand-in type is served as.
 *
 * A stand-in's record usually carries the MIME its writer sent, and this is the
 * fallback when it does not. `<video>` refuses bytes served as
 * `application/octet-stream`, so the fallback has to be right rather than
 * generic.
 */
export const STAND_IN_MIME_TYPES: Readonly<Record<string, string>> = {
  "image/avif": "image/avif",
  "video/webm": "video/webm",
};

/** The kinds of node that carry a default sync-down ceiling. */
export type NodeKind = "phone" | "desktop";

/**
 * The largest fidelity a node receives by default, per category. Null means
 * the node receives no stand-ins in that category by default and fetches each
 * one on demand.
 */
export type SyncDownCeilings = Readonly<Record<StandInCategory, number | null>>;

/**
 * A phone screen rarely benefits from more than 1280 pixels, and a desktop
 * fullscreen view needs 2560. Neither kind of node receives video stand-ins
 * by default; a video's poster frame is a derived record rather than
 * a stand-in, so it syncs regardless.
 */
export const DEFAULT_SYNC_DOWN_CEILINGS: Readonly<Record<NodeKind, SyncDownCeilings>> = {
  phone: { image: 1280, video: null },
  desktop: { image: 2560, video: null },
};

/**
 * Problems with a set of standards, as sentences. Empty when the set is
 * usable.
 *
 * Checked once at load rather than trusted, because every rule downstream
 * assumes the sizes ascend and sit below the threshold, and a set that breaks
 * either would admit a smaller stand-in the canonical one cannot outrank.
 */
export function validateStandInStandards(standards: StandInStandards): string[] {
  const problems: string[] = [];
  for (const category of STAND_IN_CATEGORIES) {
    const s = standards[category];
    if (!s) {
      problems.push(`${category}: missing`);
      continue;
    }
    if (!isPositiveInteger(s.canonicalThreshold)) {
      problems.push(`${category}: canonicalThreshold must be a positive integer`);
    }
    if (s.allowedTypes.length === 0) problems.push(`${category}: no allowed stand-in types`);
    for (const type of s.allowedTypes) {
      if (!type.startsWith(`${category}/`)) {
        problems.push(`${category}: allowed type ${type} is outside the category`);
      }
    }
    let previous = 0;
    for (const size of s.standardSizes) {
      if (!isPositiveInteger(size)) problems.push(`${category}: standard size ${size} is not a positive integer`);
      if (size <= previous) problems.push(`${category}: standard sizes must ascend`);
      if (size >= s.canonicalThreshold) {
        problems.push(`${category}: standard size ${size} is not below the canonical threshold`);
      }
      previous = size;
    }
    if (s.advisoryLongEdges) {
      const edges = s.advisoryLongEdges;
      if (!isPositiveInteger(edges.canonical)) {
        problems.push(`${category}: the canonical advisory long edge must be a positive integer`);
      }
      for (const size of s.standardSizes) {
        if (!isPositiveInteger(edges.bySize[size])) {
          problems.push(`${category}: standard size ${size} has no advisory long edge`);
        }
      }
    }
  }
  return problems;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
