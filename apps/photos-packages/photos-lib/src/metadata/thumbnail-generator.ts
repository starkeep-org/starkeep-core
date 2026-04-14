import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";
import { IMAGE_RECORD_TYPE } from "../manifest.js";

export const THUMBNAIL_GENERATOR_ID = "@photos/app:thumbnail";
export const THUMBNAIL_MAX_WIDTH = 400;

export interface ResizeResult {
  data: Uint8Array;
  width: number;
  height: number;
}

export type ResizeFunction = (
  imageBytes: Uint8Array,
  maxWidth: number,
) => Promise<ResizeResult>;

/**
 * Generates a thumbnail for an image and stores it in object storage.
 *
 * Non-syncable: the thumbnail is deterministically derived from the image bytes.
 *
 * The `resizeFn` is injected at SDK init time so that different environments
 * can use the appropriate implementation:
 *   - photos-web (Node.js): pass a `sharp`-based resize function
 *   - photos-desktop (Tauri webview): pass a Canvas API resize function
 */
export function createThumbnailGenerator(resizeFn: ResizeFunction): GeneratingFunctionDefinition {
  return {
    generatorId: THUMBNAIL_GENERATOR_ID,
    generatorVersion: 1,
    inputTypes: [IMAGE_RECORD_TYPE],
    dependsOn: [],
    outputColumns: [
      { name: "thumbnail_key", columnType: "text" },
      { name: "thumbnail_width", columnType: "integer" },
      { name: "thumbnail_height", columnType: "integer" },
    ],

    async generate(input, context) {
      const record = await context.databaseAdapter.get(input.dataRecordId);
      if (!record?.objectStorageKey) {
        return { value: { thumbnailKey: null, thumbnailWidth: 0, thumbnailHeight: 0 } };
      }

      const storageResult = await context.objectStorageAdapter.get(record.objectStorageKey);
      if (!storageResult) {
        return { value: { thumbnailKey: null, thumbnailWidth: 0, thumbnailHeight: 0 } };
      }

      const imageBytes =
        storageResult.data instanceof Uint8Array
          ? storageResult.data
          : new Uint8Array(storageResult.data as ArrayBuffer);

      const resized = await resizeFn(imageBytes, THUMBNAIL_MAX_WIDTH);
      const thumbnailKey = `images/thumbnails/${record.id}`;

      await context.objectStorageAdapter.put(thumbnailKey, resized.data, {
        contentType: "image/jpeg",
      });

      return {
        value: {
          thumbnailKey,
          thumbnailWidth: resized.width,
          thumbnailHeight: resized.height,
        },
      };
    },
  };
}
