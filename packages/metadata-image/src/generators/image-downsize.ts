import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";

/**
 * Creates an image downsize generator that produces a scaled-down version of
 * an image, stored as a file-backed metadata record.
 *
 * - Resize algorithm: Catmull-Rom bicubic (kernel: 'cubic' in sharp/libvips)
 * - Output format: JPEG quality 85 for images without alpha, WebP quality 76
 *   for images with alpha (JPEG does not support transparency)
 * - withoutEnlargement: images smaller than maxDimension are not upscaled
 * - syncable: true — downsizes sync across devices so each device doesn't
 *   regenerate what another already produced
 */
export function createImageDownsizeGenerator(
  maxDimension: number,
): GeneratingFunctionDefinition {
  return {
    generatorId: `@starkeep/image:downsize-${maxDimension}`,
    generatorVersion: 1,
    inputTypes: ["@starkeep/image"],
    dependsOn: [],
    syncable: true,
    outputColumns: [
      { name: "downsize_width", columnType: "integer" },
      { name: "downsize_height", columnType: "integer" },
      { name: "downsize_format", columnType: "text" },
    ],

    async generate(input, context) {
      const record = await context.databaseAdapter.get(input.dataRecordId);
      if (!record || !record.objectStorageKey) {
        return { value: { downsizeWidth: 0, downsizeHeight: 0, downsizeFormat: null } };
      }

      const storageResult = await context.objectStorageAdapter.get(record.objectStorageKey);
      if (!storageResult) {
        return { value: { downsizeWidth: 0, downsizeHeight: 0, downsizeFormat: null } };
      }

      const { default: sharp } = await import("sharp") as { default: typeof import("sharp") };

      const inputBuffer = Buffer.from(
        storageResult.data instanceof Uint8Array
          ? storageResult.data
          : new Uint8Array(storageResult.data as ArrayBuffer),
      );

      // Inspect metadata to determine if the image has an alpha channel.
      const meta = await sharp(inputBuffer).metadata();
      const hasAlpha = meta.hasAlpha ?? false;

      const resized = await sharp(inputBuffer)
        .resize(maxDimension, maxDimension, {
          fit: "inside",
          kernel: "cubic",
          withoutEnlargement: true,
        })
        [hasAlpha ? "webp" : "jpeg"](hasAlpha ? { quality: 76 } : { quality: 85 })
        .toBuffer();

      const outputMeta = await sharp(resized).metadata();
      const format = hasAlpha ? "webp" : "jpeg";
      const mimeType = hasAlpha ? "image/webp" : "image/jpeg";

      return {
        value: {
          downsizeWidth: outputMeta.width ?? 0,
          downsizeHeight: outputMeta.height ?? 0,
          downsizeFormat: format,
        },
        file: {
          data: new Uint8Array(resized),
          mimeType,
        },
      };
    },
  };
}
