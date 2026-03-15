import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";

const PNG_SIGNATURE_BYTE = 0x89;
const JPEG_MARKER_PREFIX = 0xff;
const JPEG_SOF0_MARKER = 0xc0;
const JPEG_SOF2_MARKER = 0xc2;

function parsePngDimensions(buffer: Buffer): { width: number; height: number } {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } {
  for (let offset = 0; offset < buffer.length - 1; offset++) {
    if (
      buffer[offset] === JPEG_MARKER_PREFIX &&
      (buffer[offset + 1] === JPEG_SOF0_MARKER || buffer[offset + 1] === JPEG_SOF2_MARKER)
    ) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
  }
  return { width: 0, height: 0 };
}

function detectImageFormat(buffer: Buffer): "png" | "jpeg" | "unknown" {
  if (buffer.length >= 8 && buffer[0] === PNG_SIGNATURE_BYTE) {
    return "png";
  }
  if (buffer.length >= 2 && buffer[0] === JPEG_MARKER_PREFIX && buffer[1] === 0xd8) {
    return "jpeg";
  }
  return "unknown";
}

export const IMAGE_DIMENSIONS_GENERATOR: GeneratingFunctionDefinition = {
  generatorId: "@starkeep/metadata-core:image-dimensions",
  generatorVersion: 1,
  inputTypes: ["@starkeep/photo", "@starkeep/image"],
  dependsOn: [],

  async generate(input, context) {
    const targetRecord = await context.databaseAdapter.get(input.dataRecordId);

    if (!targetRecord || targetRecord.kind !== "data" || !targetRecord.objectStorageKey) {
      return { value: { width: 0, height: 0, format: "unknown" } };
    }

    const storageResult = await context.objectStorageAdapter.get(targetRecord.objectStorageKey);

    if (!storageResult) {
      return { value: { width: 0, height: 0, format: "unknown" } };
    }

    const buffer = Buffer.from(storageResult.data);
    const format = detectImageFormat(buffer);

    if (format === "png") {
      const dimensions = parsePngDimensions(buffer);
      return { value: { width: dimensions.width, height: dimensions.height, format: "png" } };
    }

    if (format === "jpeg") {
      const dimensions = parseJpegDimensions(buffer);
      return { value: { width: dimensions.width, height: dimensions.height, format: "jpeg" } };
    }

    return { value: { width: 0, height: 0, format: "unknown" } };
  },
};
