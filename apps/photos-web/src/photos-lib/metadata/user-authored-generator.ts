import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";
import { IMAGE_RECORD_TYPE } from "../manifest";

export const USER_AUTHORED_GENERATOR_ID = "@photos/app:user-authored";

/**
 * Stores user-authored metadata for an image: caption, title, and an optional
 * date-taken override (for correcting incorrect EXIF dates).
 *
 * Syncable because values come from user input and may differ across devices.
 * Values are written via sdk.metadata.putDirect(), not computed from the file.
 */
export const userAuthoredGenerator: GeneratingFunctionDefinition = {
  generatorId: USER_AUTHORED_GENERATOR_ID,
  generatorVersion: 1,
  inputTypes: [IMAGE_RECORD_TYPE],
  dependsOn: [],
  syncable: true,
  outputColumns: [
    { name: "caption", columnType: "text" },
    { name: "title", columnType: "text" },
    { name: "date_taken_override", columnType: "text" },
  ],

  // Never called directly — values are always written via sdk.metadata.putDirect().
  async generate() {
    return {
      value: {
        caption: "",
        title: "",
        dateTakenOverride: null,
      },
    };
  },
};
