import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";
import { IMAGE_RECORD_TYPE } from "../manifest.js";

export const PROVENANCE_GENERATOR_ID = "@photos/app:provenance";

/**
 * Stores the provenance of an image: original filename, Google Photos ID,
 * and crop relationship to a source image.
 *
 * Syncable because two devices may independently store different provenance
 * (e.g. different original filenames from different imports). Values are
 * written via sdk.metadata.putDirect(), not computed from the file.
 */
export const provenanceGenerator: GeneratingFunctionDefinition = {
  generatorId: PROVENANCE_GENERATOR_ID,
  generatorVersion: 1,
  inputTypes: [IMAGE_RECORD_TYPE],
  dependsOn: [],
  syncable: true,
  outputColumns: [
    { name: "original_filename", columnType: "text" },
    { name: "google_photos_id", columnType: "text" },
    { name: "source_image_id", columnType: "text" },
    { name: "crop_x", columnType: "integer" },
    { name: "crop_y", columnType: "integer" },
    { name: "crop_width", columnType: "integer" },
    { name: "crop_height", columnType: "integer" },
  ],

  // Never called directly — values are always written via sdk.metadata.putDirect().
  async generate() {
    return {
      value: {
        originalFilename: "",
        googlePhotosId: null,
        sourceImageId: null,
        cropX: null,
        cropY: null,
        cropWidth: null,
        cropHeight: null,
      },
    };
  },
};
