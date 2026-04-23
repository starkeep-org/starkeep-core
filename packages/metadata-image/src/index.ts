export { createImageDownsizeGenerator } from "./generators/image-downsize.js";
export { registerImageDownsizeGenerators } from "./register.js";

import { createImageDownsizeGenerator } from "./generators/image-downsize.js";

/** 400px max dimension — grid thumbnails, contact sheets. Eager at ingest. */
export const DOWNSIZE_400 = createImageDownsizeGenerator(400);

/** 800px max dimension — detail strip, medium zoom. Lazy + cache. */
export const DOWNSIZE_800 = createImageDownsizeGenerator(800);

/** 1600px max dimension — full-screen single-photo view. Lazy + cache. */
export const DOWNSIZE_1600 = createImageDownsizeGenerator(1600);

export const STANDARD_DOWNSIZE_GENERATORS = [DOWNSIZE_400, DOWNSIZE_800, DOWNSIZE_1600] as const;

/** Returns the generator ID for a given max dimension. Useful in thin-client
 *  apps that POST results without importing the full generator definition. */
export const downsizeGeneratorId = (maxDimension: number): string =>
  `@starkeep/image:downsize-${maxDimension}`;
