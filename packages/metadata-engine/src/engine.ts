import { createHash } from "node:crypto";
import type { StarkeepId, MetadataRecord } from "@starkeep/core";
import type {
  MetadataEngine,
  MetadataEngineOptions,
  GenerationRequest,
  GenerationResult,
  GeneratingFunctionOutput,
  MetadataSyncRecord,
} from "./types.js";
import { computeInputHash } from "./input-hasher.js";
import { GeneratorNotFoundError, GenerationError } from "./errors.js";

/** Stores a generated file in object storage. Returns file-backing fields. */
async function storeGeneratedFile(
  output: GeneratingFunctionOutput,
  objectStorageAdapter: MetadataEngineOptions["objectStorageAdapter"],
): Promise<{ objectStorageKey: string; contentHash: string; mimeType: string; sizeBytes: number } | null> {
  if (!output.file) return null;
  const { data, mimeType } = output.file;
  const hex = createHash("sha256").update(data).digest("hex");
  await objectStorageAdapter.put(hex, data, { contentType: mimeType });
  return { objectStorageKey: hex, contentHash: hex, mimeType, sizeBytes: data.byteLength };
}

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
    targetType: string,
    generatorId: string,
  ): Promise<MetadataRecord | null> {
    const result = await databaseAdapter.queryMetadata(targetType, {
      targetId,
      generatorId,
    });
    return result.entries[0] ?? null;
  }

  return {
    async generate(request: GenerationRequest): Promise<GenerationResult> {
      const definition = generatorRegistry.get(request.generatorId);
      if (!definition) {
        throw new GeneratorNotFoundError(request.generatorId);
      }

      const targetRecord = await databaseAdapter.get(request.targetId);
      if (!targetRecord) {
        throw new GenerationError(
          `Target data record not found: ${request.targetId}`,
          request.generatorId,
        );
      }

      // Collect dependency input hashes to include in this generator's input hash.
      const dependencyHashes: string[] = [];
      for (const dependencyGeneratorId of definition.dependsOn) {
        const dependencyMetadata = await findExistingMetadata(
          request.targetId,
          request.targetType,
          dependencyGeneratorId,
        );
        if (dependencyMetadata) {
          // inputHash may be empty string for user-authored entries; use it as-is.
          dependencyHashes.push(dependencyMetadata.inputHash);
        }
      }

      const inputHash = await computeInputHash(
        request.targetId,
        dependencyHashes,
        request.parameters ?? {},
      );

      const existing = await findExistingMetadata(
        request.targetId,
        request.targetType,
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
            targetType: request.targetType,
            dependencyIds: dependencyHashes as unknown as StarkeepId[],
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

      const fileFields = await storeGeneratedFile(output, objectStorageAdapter);

      const metadataRecord: MetadataRecord = {
        targetId: request.targetId,
        generatorId: definition.generatorId,
        generatorVersion: definition.generatorVersion,
        inputHash,
        value: output.value,
        ...fileFields,
      };

      if (definition.syncable) {
        await databaseAdapter.upsertSyncableMetadata({
          targetId: request.targetId,
          targetType: request.targetType,
          generatorId: definition.generatorId,
          generatorVersion: definition.generatorVersion,
          inputHash,
          updatedAt: clock.now(),
          value: output.value,
          ...fileFields,
        });
      } else {
        await databaseAdapter.putMetadata(request.targetType, metadataRecord);
      }

      return {
        metadataRecord,
        wasStale: existing !== null,
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
          targetType: dataType,
          mode: "on-demand",
        });
        results.push(result);
      }

      return results;
    },

    async checkStaleness(
      targetId: StarkeepId,
      targetType: string,
      generatorId: string,
    ): Promise<boolean> {
      const existing = await findExistingMetadata(targetId, targetType, generatorId);
      if (!existing) return true;

      const definition = generatorRegistry.get(generatorId);
      if (!definition) return true;

      if (existing.generatorVersion < definition.generatorVersion) {
        return true;
      }

      const dependencyHashes: string[] = [];
      for (const dependencyGeneratorId of definition.dependsOn) {
        const dependencyMetadata = await findExistingMetadata(
          targetId,
          targetType,
          dependencyGeneratorId,
        );
        if (dependencyMetadata) {
          dependencyHashes.push(dependencyMetadata.inputHash);
        }
      }

      const currentInputHash = await computeInputHash(targetId, dependencyHashes, {});
      return currentInputHash !== existing.inputHash;
    },

    async writeDirect(
      targetId: StarkeepId,
      targetType: string,
      generatorId: string,
      value: Record<string, unknown>,
      file?: { data: Uint8Array; mimeType: string },
    ): Promise<MetadataSyncRecord> {
      const definition = generatorRegistry.get(generatorId);
      if (!definition) {
        throw new GeneratorNotFoundError(generatorId);
      }
      if (!definition.syncable) {
        throw new GenerationError(
          `Generator "${generatorId}" is not syncable. Set syncable: true to allow direct writes.`,
          generatorId,
        );
      }

      // Derive a stable input hash from the written value so dependent
      // generators can detect when this value has changed.
      const inputHash = await computeInputHash(targetId, [], { value });

      const fileFields = file
        ? await storeGeneratedFile({ value, file }, objectStorageAdapter)
        : null;

      const syncRecord: MetadataSyncRecord = {
        targetId,
        targetType,
        generatorId,
        generatorVersion: definition.generatorVersion,
        inputHash,
        updatedAt: clock.now(),
        value,
        ...fileFields,
      };

      await databaseAdapter.upsertSyncableMetadata(syncRecord);
      return syncRecord;
    },
  };
}
