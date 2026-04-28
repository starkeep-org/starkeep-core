import { createDataRecord, type DataRecord, type HLCClock } from "@starkeep/core";
import { IMAGE_RECORD_TYPE } from "../manifest";

export { IMAGE_RECORD_TYPE };

export function createImageRecord(options: {
  mimeType: string;
  objectStorageKey: string;
  contentHash: string;
  sizeBytes: number;
  clock: HLCClock;
  ownerId: string;
}): DataRecord {
  return createDataRecord(
    {
      type: IMAGE_RECORD_TYPE,
      ownerId: options.ownerId,
      content: {},
      contentHash: options.contentHash,
      objectStorageKey: options.objectStorageKey,
      mimeType: options.mimeType,
      sizeBytes: options.sizeBytes,
    },
    options.clock,
  );
}
