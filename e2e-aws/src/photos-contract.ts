/**
 * Photos' own ladder and label spelling, read out of the sibling starkeep-apps
 * checkout at run time.
 *
 * The rendition steps of the journey assert against definitions this suite does
 * not own: which rungs apply to a source of a given size, what the
 * `photos/rendition` label is called, and what a published rung's file is named.
 * Copying any of them into this repository would leave the expectation one
 * respecification behind the app, and the failure would be silent — "a rung is
 * missing" rather than a 400 naming the key the platform refused. This suite has
 * already paid that once: its cross-app label step kept writing `photos/thumbnail`
 * after the respec replaced it, and only a real DSQL cluster caught it.
 *
 * Loaded by absolute path rather than imported, because starkeep-apps is a
 * separate pnpm workspace that nothing in this package's dependency graph can
 * name. Both modules are dependency-free at run time — `ladder.ts` imports
 * nothing at all, and `publish-renditions.ts` imports one constants module plus a
 * type — so the load pulls in neither sharp nor Next.
 *
 * `vitest.config.ts` widens Vite's `server.fs.allow` to the checkouts root.
 * Without that entry the load is refused as outside the serving root.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Sibling checkout holding the Photos app. */
const APPS_DIR = resolve(PACKAGE_ROOT, "../..", "starkeep-apps");

const LADDER_MODULE = resolve(APPS_DIR, "packages/photos-ladder/src/ladder.ts");
const PUBLISH_MODULE = resolve(APPS_DIR, "photos/src/photos-lib/image-processing/publish-renditions.ts");

export interface StillClassSpec {
  readonly sizeClass: string;
  /** Maximum long edge in pixels. A maximum, never a target. */
  readonly maxLongEdge: number;
}

export interface PhotosContract {
  /** The still ladder, ascending. */
  readonly stillLadder: readonly StillClassSpec[];
  /** Which still classes apply to an original of this long edge. */
  applicableStillClasses(originalLongEdge: number): StillClassSpec[];
  /** `photos/rendition` — the label ref a caller asks the server about. */
  readonly renditionLabelRef: string;
  /** What a published rung's file is called. */
  renditionFileName(originalFilename: string | null, sizeClass: string): string;
}

let cached: Promise<PhotosContract> | undefined;

/** Load Photos' contract once per run. */
export function photosContract(): Promise<PhotosContract> {
  cached ??= load();
  return cached;
}

async function load(): Promise<PhotosContract> {
  const [ladder, publish] = await Promise.all([
    // @vite-ignore: the specifier is an absolute path outside this package, so
    // there is nothing for Vite to analyze at build time.
    import(/* @vite-ignore */ LADDER_MODULE) as Promise<{
      STILL_LADDER: readonly StillClassSpec[];
      applicableStillClasses(originalLongEdge: number): StillClassSpec[];
    }>,
    import(/* @vite-ignore */ PUBLISH_MODULE) as Promise<{
      RENDITION_LABEL_REF: string;
      renditionFileName(originalFilename: string | null, sizeClass: string): string;
    }>,
  ]);
  return {
    stillLadder: ladder.STILL_LADDER,
    applicableStillClasses: ladder.applicableStillClasses,
    renditionLabelRef: publish.RENDITION_LABEL_REF,
    renditionFileName: publish.renditionFileName,
  };
}
