/**
 * A derived child record of an original, as `?variant=<appId>/<key>` lists it.
 *
 * A derived record is anything an app made from an original that does not
 * stand in for it — a video's poster, a skim, a crop — and carries the app's
 * label. The listing hands every such child back with its dimensions and lets
 * the app choose among them. Choosing a *size* of the original is not done
 * here: a content read at a size answers that from the original's stand-ins,
 * which the platform keeps one per standard size.
 *
 * Nothing in this file names a size class.
 */

import type { StarkeepId } from "../identifiers/types.js";

/** A derived child record, with the label value that made it one. */
export interface VariantCandidate {
  readonly id: StarkeepId;
  readonly objectStorageKey: string;
  /** Canonical Starkeep type of the child, which may differ from its parent's. */
  readonly type: string;
  /** Value of the label that made this child a candidate. */
  readonly labelValue: string;
  /** From the per-category metadata table. Null when not (yet) extracted. */
  readonly width: number | null;
  readonly height: number | null;
}
