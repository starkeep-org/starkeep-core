import { createMetadataRecord } from "@starkeep/core";
import type { StarkeepId, MetadataRecord, DataRecord } from "@starkeep/core";
import type {
  MetadataEngine,
  MetadataEngineOptions,
  GenerationRequest,
  GenerationResult,
} from "./types.js";
import { computeInputHash } from "./input-hasher.js";
import { GeneratorNotFoundError, GenerationError } from "./errors.js";

export function createMetadataEngine(
  options: MetadataEngineOptions,
): MetadataEngine {
  const {
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId,
    generatorRegistry,
    dependencyGraph,
  } = options;

  const generationContext = {
    databaseAdapter,
    objectStorageAdapter,
    clock,
    ownerId,
  };

  async function findExistingMetadata(
    targetId: StarkeepId,
    generatorId: string,
  ): Promise<MetadataRecord | null> {
    const result = await databaseAdapter.query({
      kind: "metadata",
      filters: [
        { field: "targetId", operator: "eq", value: targetId },
        { field: "generatorId", operator: "eq", value: generatorId },
      ],
      limit: 1,
    });
    return (result.records[0] as MetadataRecord) ?? null;
  }

  return {
    async generate(request: GenerationRequest): Promise<GenerationResult> {
      const definition = generatorRegistry.get(request.generatorId);
      if (!definition) {
        throw new GeneratorNotFoundError(request.generatorId);
      }

      const targetRecord = await databaseAdapter.get(request.targetId);
      if (!targetRecord || targetRecord.kind !== "data") {
        throw new GenerationError(
          `Target data record not found: ${request.targetId}`,
          request.generatorId,
        );
      }

      const dependencyIds: StarkeepId[] = [];
      for (const dependencyGeneratorId of definition.dependsOn) {
        const dependencyMetadata = await findExistingMetadata(
          request.targetId,
          dependencyGeneratorId,
        );
        if (dependencyMetadata) {
          dependencyIds.push(dependencyMetadata.id);
        }
      }

      const inputHash = await computeInputHash(
        request.targetId,
        dependencyIds,
        request.parameters ?? {},
      );

      const existing = await findExistingMetadata(
        request.targetId,
        request.generatorId,
      );

      if (existing && existing.inputHash === inputHash) {
        return {
          metadataRecord: existing,
          wasStale: false,
          skippedBecauseCached: true,
        };
      }

      let output;
      try {
        output = await definition.generate(
          {
            dataRecordId: request.targetId,
            dependencyIds,
            parameters: request.parameters ?? {},
          },
          generationContext,
        );
      } catch (error) {
        throw new GenerationError(
          `Generator "${request.generatorId}" failed for target "${request.targetId}"`,
          request.generatorId,
          error,
        );
      }

      if (existing) {
        const updated: MetadataRecord = {
          ...existing,
          updatedAt: clock.now(),
          generatorVersion: definition.generatorVersion,
          inputHash,
          value: output.value,
          version: existing.version + 1,
        };
        await databaseAdapter.put(updated);
        return {
          metadataRecord: updated,
          wasStale: true,
          skippedBecauseCached: false,
        };
      }

      const metadataRecord = createMetadataRecord(
        {
          type: definition.generatorId,
          ownerId,
          targetId: request.targetId,
          generatorId: definition.generatorId,
          generatorVersion: definition.generatorVersion,
          inputHash,
          value: output.value,
        },
        clock,
      );

      await databaseAdapter.put(metadataRecord);

      return {
        metadataRecord,
        wasStale: false,
        skippedBecauseCached: false,
      };
    },

    async generateAll(
      targetId: StarkeepId,
      dataType: string,
    ): Promise<GenerationResult[]> {
      const generationOrder = dependencyGraph.getGenerationOrder(dataType);
      const results: GenerationResult[] = [];

      for (const generatorId of generationOrder) {
        const result = await this.generate({
          generatorId,
          targetId,
          mode: "on-demand",
        });
        results.push(result);
      }

      return results;
    },

    async checkStaleness(metadataRecordId: StarkeepId): Promise<boolean> {
      const record = await databaseAdapter.get(metadataRecordId);
      if (!record || record.kind !== "metadata") {
        throw new GenerationError(
          `Metadata record not found: ${metadataRecordId}`,
          "unknown",
        );
      }

      const metadataRecord = record as MetadataRecord;
      const definition = generatorRegistry.get(metadataRecord.generatorId);
      if (!definition) {
        return true;
      }

      if (metadataRecord.generatorVersion < definition.generatorVersion) {
        return true;
      }

      const dependencyIds: StarkeepId[] = [];
      for (const dependencyGeneratorId of definition.dependsOn) {
        const dependencyMetadata = await findExistingMetadata(
          metadataRecord.targetId,
          dependencyGeneratorId,
        );
        if (dependencyMetadata) {
          dependencyIds.push(dependencyMetadata.id);
        }
      }

      const currentInputHash = await computeInputHash(
        metadataRecord.targetId,
        dependencyIds,
        {},
      );

      return currentInputHash !== metadataRecord.inputHash;
    },
  };
}
