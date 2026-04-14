/** The canonical app ID for the photos app. */
export const PHOTOS_APP_ID = "@photos/app";

/**
 * Global type for a raw raster image file.
 * Already referenced by IMAGE_DIMENSIONS_GENERATOR.inputTypes in @starkeep/metadata-core.
 */
export const IMAGE_RECORD_TYPE = "@starkeep/image";

/**
 * Global type for an ordered collection of images.
 * More abstract types reference more concrete ones per the architecture heuristic.
 */
export const ALBUM_RECORD_TYPE = "media:album";

/**
 * All record types that the photos app reads and writes.
 * An owner-level SDK must grant policies for each of these before the
 * app-scoped SDK is initialised.
 */
export const PHOTOS_APP_RECORD_TYPES = [
  IMAGE_RECORD_TYPE,
  ALBUM_RECORD_TYPE,
  "@starkeep/access-policy",
  "@starkeep/sharing-token",
] as const;
