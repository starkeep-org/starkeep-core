import type { GeneratingFunctionDefinition } from "@starkeep/metadata-engine";

export const FILE_PROPERTIES_GENERATOR: GeneratingFunctionDefinition = {
  generatorId: "@starkeep/metadata-core:file-properties",
  generatorVersion: 1,
  inputTypes: ["*"],
  dependsOn: [],
  outputColumns: [
    { name: "size_bytes", columnType: "integer" },
    { name: "mime_type", columnType: "text" },
    { name: "content_hash", columnType: "text" },
  ],

  async generate(input, context) {
    const targetRecord = await context.databaseAdapter.get(input.dataRecordId);

    if (!targetRecord) {
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
