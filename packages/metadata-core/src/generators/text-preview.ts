import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";

const MAXIMUM_PREVIEW_BYTES = 500;

function truncateAtLastSpaceBoundary(text: string, maximumLength: number): string {
  if (text.length <= maximumLength) {
    return text;
  }
  const lastSpaceIndex = text.lastIndexOf(" ", maximumLength);
  if (lastSpaceIndex === -1) {
    return text.slice(0, maximumLength);
  }
  return text.slice(0, lastSpaceIndex);
}

export const TEXT_PREVIEW_GENERATOR: GeneratingFunctionDefinition = {
  generatorId: "@starkeep/metadata-core:text-preview",
  generatorVersion: 1,
  inputTypes: ["@starkeep/document", "@starkeep/note"],
  dependsOn: [],

  async generate(input, context) {
    const targetRecord = await context.databaseAdapter.get(input.dataRecordId);

    if (!targetRecord || targetRecord.kind !== "data") {
      return { value: { preview: "", characterCount: 0 } };
    }

    let rawText: string | null = null;

    if (targetRecord.objectStorageKey) {
      const storageResult = await context.objectStorageAdapter.get(targetRecord.objectStorageKey);
      if (storageResult) {
        const previewBytes = Buffer.from(storageResult.data).subarray(0, MAXIMUM_PREVIEW_BYTES);
        rawText = new TextDecoder("utf-8").decode(previewBytes);
      }
    }

    if (rawText === null && targetRecord.payload && typeof targetRecord.payload.content === "string") {
      rawText = targetRecord.payload.content;
    }

    if (rawText === null) {
      return { value: { preview: "", characterCount: 0 } };
    }

    const preview = truncateAtLastSpaceBoundary(rawText, MAXIMUM_PREVIEW_BYTES);
    return { value: { preview, characterCount: preview.length } };
  },
};
