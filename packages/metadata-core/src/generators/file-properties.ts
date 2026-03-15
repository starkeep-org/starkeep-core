import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";

export const FILE_PROPERTIES_GENERATOR: GeneratingFunctionDefinition = {
  generatorId: "@starkeep/metadata-core:file-properties",
  generatorVersion: 1,
  inputTypes: ["*"],
  dependsOn: [],

  async generate(input, context) {
    const targetRecord = await context.databaseAdapter.get(input.dataRecordId);

    if (!targetRecord || targetRecord.kind !== "data") {
      return { value: { sizeBytes: null, mimeType: null, contentHash: null } };
    }

    return {
      value: {
        sizeBytes: targetRecord.sizeBytes,
        mimeType: targetRecord.mimeType,
        contentHash: targetRecord.contentHash,
      },
    };
  },
};
